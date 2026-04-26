// app/private/AddLiquidityForm.tsx
//
// Adds liquidity to a wrapped DLMM position. Uses @meteora-ag/dlmm SDK
// helpers to derive bin arrays, reserves, and the active id; encodes a
// LiquidityParameterByStrategy and forwards it through the wrapper.
//
// Limited to v1 add_liquidity_by_strategy, which is hardcoded by Meteora
// to legacy SPL Token (TokenkegQ...). Token-2022 pools are out of scope
// here — those need add_liquidity_by_strategy2.

'use client';

import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useConnection, useWallet} from '@solana/wallet-adapter-react';
import {Keypair, PublicKey, SystemProgram, Transaction} from '@solana/web3.js';
import BN from 'bn.js';
import DLMM, {
    binIdToBinArrayIndex,
    deriveBinArray,
    deriveBinArrayBitmapExtension,
    LBCLMM_PROGRAM_IDS,
} from '@meteora-ag/dlmm';

const METEORA_PROGRAM_ID_MAINNET = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']);

const SIG_STORAGE_KEY = 'privateWrapMasterSig';
import {
    createAssociatedTokenAccountIdempotentInstruction,
    getAssociatedTokenAddressSync,
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
    createSyncNativeInstruction,
} from '@solana/spl-token';
import {
    buildAddLiquidityIx,
    buildInitializeBinArrayIx,
    deriveEphemeralKeypair,
    deriveNonceFromSignature,
    encodeLiquidityParameterByStrategy,
    METEORA_DLMM_PROGRAM_ID,
    StrategyTypeOnChain,
} from '@/app/utils/privateWrap';

interface Props {
    /** Index of the position (corresponds to nonce derivation index). */
    index: number;
    /** Position pubkey (the on-chain DLMM Position account). */
    position: PublicKey;
    /** LB pair the position lives in. */
    lbPair: PublicKey;
    onDone?: () => void;
}

export default function AddLiquidityForm({index, position, lbPair, onDone}: Props) {
    const {connection} = useConnection();
    const {publicKey} = useWallet();

    const [masterSig, setMasterSig] = useState<Uint8Array | null>(null);
    const [amountX, setAmountX] = useState('0');
    const [amountY, setAmountY] = useState('0');
    const [strategyType, setStrategyType] = useState<StrategyTypeOnChain>(
        StrategyTypeOnChain.SpotBalanced
    );
    const [maxSlippage, setMaxSlippage] = useState('5');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        const sigHex = localStorage.getItem(SIG_STORAGE_KEY);
        if (sigHex) setMasterSig(new Uint8Array(Buffer.from(sigHex, 'hex')));
    }, []);

    const nonce = useMemo(
        () => (masterSig ? deriveNonceFromSignature(masterSig, index) : null),
        [masterSig, index]
    );

    const ephemeral: Keypair | null = useMemo(
        () => (masterSig ? deriveEphemeralKeypair(masterSig) : null),
        [masterSig]
    );

    const submit = useCallback(async () => {
        setError('');
        setStatus('');
        if (!publicKey) {
            setError('Connect wallet');
            return;
        }
        if (!nonce || !ephemeral) {
            setError('Sign unlock message first');
            return;
        }

        setBusy(true);
        try {
            setStatus('Loading pool...');
            const dlmm = await DLMM.create(connection, lbPair);

            // Position account stores its lower/upper bin id; load it.
            const positionInfo = await dlmm.program.account.positionV2.fetch(position);
            const lowerBinId = positionInfo.lowerBinId as number;
            const upperBinId = positionInfo.upperBinId as number;
            const activeId = dlmm.lbPair.activeId;

            const lowerArrayIndex = binIdToBinArrayIndex(new BN(lowerBinId));
            const upperArrayIndex = binIdToBinArrayIndex(new BN(upperBinId));

            const programId = METEORA_PROGRAM_ID_MAINNET;
            const [binArrayLower] = deriveBinArray(lbPair, lowerArrayIndex, programId);
            const [binArrayUpper] = deriveBinArray(lbPair, upperArrayIndex, programId);
            const [bitmapExt] = deriveBinArrayBitmapExtension(lbPair, programId);

            // Pre-init bin arrays if they don't exist on-chain yet. First user
            // to LP in a fresh bin range pays this rent (~0.057 SOL each).
            const [lowerInfo, upperInfo, bitmapInfo] = await Promise.all([
                connection.getAccountInfo(binArrayLower),
                connection.getAccountInfo(binArrayUpper),
                connection.getAccountInfo(bitmapExt),
            ]);
            const initBinArrayIxs = [];
            if (!lowerInfo) {
                initBinArrayIxs.push(buildInitializeBinArrayIx({
                    funder: ephemeral.publicKey,
                    lbPair,
                    binArray: binArrayLower,
                    index: BigInt(lowerArrayIndex.toString()),
                }));
            }
            if (!upperInfo && !lowerArrayIndex.eq(upperArrayIndex)) {
                initBinArrayIxs.push(buildInitializeBinArrayIx({
                    funder: ephemeral.publicKey,
                    lbPair,
                    binArray: binArrayUpper,
                    index: BigInt(upperArrayIndex.toString()),
                }));
            }
            // If the pool has no bitmap extension account on-chain, Meteora
            // accepts the program id as a placeholder for the optional slot.
            const bitmapExtAccount = bitmapInfo ? bitmapExt : METEORA_DLMM_PROGRAM_ID;

            const tokenXMint: PublicKey = dlmm.lbPair.tokenXMint;
            const tokenYMint: PublicKey = dlmm.lbPair.tokenYMint;
            const reserveX: PublicKey = dlmm.lbPair.reserveX;
            const reserveY: PublicKey = dlmm.lbPair.reserveY;

            // ATAs and funding all live on the ephemeral, not the connected
            // wallet. Connected wallet must NOT appear on this transaction.
            const userTokenX = getAssociatedTokenAddressSync(tokenXMint, ephemeral.publicKey);
            const userTokenY = getAssociatedTokenAddressSync(tokenYMint, ephemeral.publicKey);

            const pre: Transaction = new Transaction();
            for (const ix of initBinArrayIxs) pre.add(ix);
            const ataXInfo = await connection.getAccountInfo(userTokenX);
            if (!ataXInfo) {
                pre.add(createAssociatedTokenAccountIdempotentInstruction(
                    ephemeral.publicKey, userTokenX, ephemeral.publicKey, tokenXMint
                ));
            }
            const ataYInfo = await connection.getAccountInfo(userTokenY);
            if (!ataYInfo) {
                pre.add(createAssociatedTokenAccountIdempotentInstruction(
                    ephemeral.publicKey, userTokenY, ephemeral.publicKey, tokenYMint
                ));
            }

            const amountXBig = BigInt(amountX || '0');
            const amountYBig = BigInt(amountY || '0');
            const ZERO = BigInt(0);

            if (tokenXMint.equals(NATIVE_MINT) && amountXBig > ZERO) {
                pre.add(SystemProgram.transfer({
                    fromPubkey: ephemeral.publicKey,
                    toPubkey: userTokenX,
                    lamports: Number(amountXBig),
                }));
                pre.add(createSyncNativeInstruction(userTokenX));
            }
            if (tokenYMint.equals(NATIVE_MINT) && amountYBig > ZERO) {
                pre.add(SystemProgram.transfer({
                    fromPubkey: ephemeral.publicKey,
                    toPubkey: userTokenY,
                    lamports: Number(amountYBig),
                }));
                pre.add(createSyncNativeInstruction(userTokenY));
            }

            const liquidityParameter = encodeLiquidityParameterByStrategy({
                amountX: amountXBig,
                amountY: amountYBig,
                activeId,
                maxActiveBinSlippage: parseInt(maxSlippage, 10) || 5,
                strategy: {
                    minBinId: lowerBinId,
                    maxBinId: upperBinId,
                    strategyType,
                },
            });

            const ix = buildAddLiquidityIx(
                {nonce, liquidityParameter},
                {
                    payer: ephemeral.publicKey,
                    position,
                    lbPair,
                    binArrayBitmapExtension: bitmapExtAccount,
                    userTokenX,
                    userTokenY,
                    reserveX,
                    reserveY,
                    tokenXMint,
                    tokenYMint,
                    binArrayLower,
                    binArrayUpper,
                    tokenXProgram: TOKEN_PROGRAM_ID,
                    tokenYProgram: TOKEN_PROGRAM_ID,
                }
            );

            const tx = pre.add(ix);
            tx.feePayer = ephemeral.publicKey;
            const {blockhash, lastValidBlockHeight} = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.sign(ephemeral);

            setStatus('Submitting (signed by ephemeral)...');
            const sig = await connection.sendRawTransaction(tx.serialize());
            setStatus(`Submitted: ${sig}. Confirming...`);
            const conf = await connection.confirmTransaction(
                {signature: sig, blockhash, lastValidBlockHeight},
                'confirmed'
            );
            if (conf.value.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
            setStatus(`Liquidity added: ${sig}`);
            onDone?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [
        connection, publicKey, ephemeral, nonce, position, lbPair,
        amountX, amountY, strategyType, maxSlippage, onDone,
    ]);

    return (
        <div className="bg-base-300 rounded p-3 space-y-2 mt-2">
            <div className="text-xs opacity-70">Add liquidity to position #{index}</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
                <label>
                    <span className="opacity-70">amount X (raw)</span>
                    <input
                        className="input input-bordered input-xs w-full mt-1"
                        value={amountX}
                        onChange={e => setAmountX(e.target.value)}
                    />
                </label>
                <label>
                    <span className="opacity-70">amount Y (raw)</span>
                    <input
                        className="input input-bordered input-xs w-full mt-1"
                        value={amountY}
                        onChange={e => setAmountY(e.target.value)}
                    />
                </label>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
                <label>
                    <span className="opacity-70">strategy</span>
                    <select
                        className="select select-bordered select-xs w-full mt-1"
                        value={strategyType}
                        onChange={e => setStrategyType(parseInt(e.target.value, 10))}
                    >
                        <option value={StrategyTypeOnChain.SpotBalanced}>Spot</option>
                        <option value={StrategyTypeOnChain.CurveBalanced}>Curve</option>
                        <option value={StrategyTypeOnChain.BidAskBalanced}>BidAsk</option>
                    </select>
                </label>
                <label>
                    <span className="opacity-70">max slippage (bins)</span>
                    <input
                        type="number"
                        className="input input-bordered input-xs w-full mt-1"
                        value={maxSlippage}
                        onChange={e => setMaxSlippage(e.target.value)}
                    />
                </label>
            </div>
            <button
                onClick={submit}
                disabled={busy || !nonce}
                className="btn btn-xs btn-accent w-full"
            >
                {busy ? <span className="loading loading-spinner loading-xs"/> : 'Add liquidity'}
            </button>
            {status && <p className="text-success text-xs break-all">{status}</p>}
            {error && <p className="text-error text-xs break-all">{error}</p>}
        </div>
    );
}

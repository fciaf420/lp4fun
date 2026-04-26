// app/private/PositionActions.tsx
//
// Exit + management actions for a wrapped DLMM position: claim fees, remove
// liquidity (partial via bps), and close. All sign with the ephemeral
// keypair so the connected wallet never appears on these on-chain txs.
//
// Tokens / rent always land on the ephemeral. The user can later re-shield
// from ephemeral through PrivacyCash to a different recipient if they want
// to break the link to ephemeral too.

'use client';

import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useConnection, useWallet} from '@solana/wallet-adapter-react';
import {Keypair, PublicKey, Transaction} from '@solana/web3.js';
import BN from 'bn.js';
import DLMM, {
    binIdToBinArrayIndex,
    deriveBinArray,
    deriveBinArrayBitmapExtension,
    LBCLMM_PROGRAM_IDS,
} from '@meteora-ag/dlmm';
import {
    createAssociatedTokenAccountIdempotentInstruction,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
    buildClaimFeesIx,
    buildClosePositionIx,
    buildRemoveLiquidityIx,
    deriveEphemeralKeypair,
    deriveNonceFromSignature,
    METEORA_DLMM_PROGRAM_ID,
} from '@/app/utils/privateWrap';

const SIG_STORAGE_KEY = 'privateWrapMasterSig';
const METEORA_PROGRAM_ID_MAINNET = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']);

interface Props {
    /** Index that derives this position's nonce. */
    index: number;
    position: PublicKey;
    lbPair: PublicKey;
    onChanged?: () => void;
}

type PoolCtx = {
    binArrayLower: PublicKey;
    binArrayUpper: PublicKey;
    bitmapExt: PublicKey;
    bitmapExists: boolean;
    reserveX: PublicKey;
    reserveY: PublicKey;
    tokenXMint: PublicKey;
    tokenYMint: PublicKey;
    userTokenX: PublicKey;
    userTokenY: PublicKey;
    lowerBinId: number;
    upperBinId: number;
    needsAtaXIx: boolean;
    needsAtaYIx: boolean;
};

export default function PositionActions({index, position, lbPair, onChanged}: Props) {
    const {connection} = useConnection();
    const {publicKey} = useWallet();

    const [masterSig, setMasterSig] = useState<Uint8Array | null>(null);
    const [bps, setBps] = useState('10000'); // default 100% of position
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        const sigHex = localStorage.getItem(SIG_STORAGE_KEY);
        if (sigHex) setMasterSig(new Uint8Array(Buffer.from(sigHex, 'hex')));
    }, []);

    const ephemeral: Keypair | null = useMemo(
        () => (masterSig ? deriveEphemeralKeypair(masterSig) : null),
        [masterSig]
    );

    const nonce = useMemo(
        () => (masterSig ? deriveNonceFromSignature(masterSig, index) : null),
        [masterSig, index]
    );

    /**
     * Loads everything we need from the pool + position to build any of the
     * three management ixs. Centralized so it doesn't get out of sync between
     * actions.
     */
    const loadCtx = useCallback(async (eph: Keypair): Promise<PoolCtx> => {
        const dlmm = await DLMM.create(connection, lbPair);
        const positionInfo = await dlmm.program.account.positionV2.fetch(position);
        const lowerBinId = positionInfo.lowerBinId as number;
        const upperBinId = positionInfo.upperBinId as number;

        const lowerArrayIndex = binIdToBinArrayIndex(new BN(lowerBinId));
        const upperArrayIndex = binIdToBinArrayIndex(new BN(upperBinId));
        const [binArrayLower] = deriveBinArray(lbPair, lowerArrayIndex, METEORA_PROGRAM_ID_MAINNET);
        const [binArrayUpper] = deriveBinArray(lbPair, upperArrayIndex, METEORA_PROGRAM_ID_MAINNET);
        const [bitmapExt] = deriveBinArrayBitmapExtension(lbPair, METEORA_PROGRAM_ID_MAINNET);
        const bitmapInfo = await connection.getAccountInfo(bitmapExt);

        const tokenXMint: PublicKey = dlmm.lbPair.tokenXMint;
        const tokenYMint: PublicKey = dlmm.lbPair.tokenYMint;
        const reserveX: PublicKey = dlmm.lbPair.reserveX;
        const reserveY: PublicKey = dlmm.lbPair.reserveY;

        const userTokenX = getAssociatedTokenAddressSync(tokenXMint, eph.publicKey);
        const userTokenY = getAssociatedTokenAddressSync(tokenYMint, eph.publicKey);
        const [ataXInfo, ataYInfo] = await Promise.all([
            connection.getAccountInfo(userTokenX),
            connection.getAccountInfo(userTokenY),
        ]);

        return {
            binArrayLower,
            binArrayUpper,
            bitmapExt,
            bitmapExists: bitmapInfo != null,
            reserveX,
            reserveY,
            tokenXMint,
            tokenYMint,
            userTokenX,
            userTokenY,
            lowerBinId,
            upperBinId,
            needsAtaXIx: ataXInfo == null,
            needsAtaYIx: ataYInfo == null,
        };
    }, [connection, lbPair, position]);

    const sendAsEphemeral = useCallback(async (eph: Keypair, tx: Transaction): Promise<string> => {
        tx.feePayer = eph.publicKey;
        const {blockhash, lastValidBlockHeight} = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.sign(eph);
        const sig = await connection.sendRawTransaction(tx.serialize());
        const conf = await connection.confirmTransaction(
            {signature: sig, blockhash, lastValidBlockHeight},
            'confirmed'
        );
        if (conf.value.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
        return sig;
    }, [connection]);

    const claim = useCallback(async () => {
        setError(''); setStatus('');
        if (!publicKey || !nonce || !ephemeral) {
            setError('Sign unlock message first');
            return;
        }
        setBusy(true);
        try {
            setStatus('Loading pool state...');
            const ctx = await loadCtx(ephemeral);

            const tx = new Transaction();
            if (ctx.needsAtaXIx) {
                tx.add(createAssociatedTokenAccountIdempotentInstruction(
                    ephemeral.publicKey, ctx.userTokenX, ephemeral.publicKey, ctx.tokenXMint
                ));
            }
            if (ctx.needsAtaYIx) {
                tx.add(createAssociatedTokenAccountIdempotentInstruction(
                    ephemeral.publicKey, ctx.userTokenY, ephemeral.publicKey, ctx.tokenYMint
                ));
            }
            tx.add(buildClaimFeesIx(
                {nonce},
                {
                    payer: ephemeral.publicKey,
                    position,
                    lbPair,
                    binArrayLower: ctx.binArrayLower,
                    binArrayUpper: ctx.binArrayUpper,
                    reserveX: ctx.reserveX,
                    reserveY: ctx.reserveY,
                    userTokenX: ctx.userTokenX,
                    userTokenY: ctx.userTokenY,
                    tokenXMint: ctx.tokenXMint,
                    tokenYMint: ctx.tokenYMint,
                    tokenProgram: TOKEN_PROGRAM_ID,
                }
            ));

            setStatus('Submitting claim...');
            const sig = await sendAsEphemeral(ephemeral, tx);
            setStatus(`Fees claimed: ${sig}`);
            onChanged?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [publicKey, nonce, ephemeral, lbPair, position, loadCtx, sendAsEphemeral, onChanged]);

    const remove = useCallback(async (closeAfter: boolean) => {
        setError(''); setStatus('');
        if (!publicKey || !nonce || !ephemeral) {
            setError('Sign unlock message first');
            return;
        }
        const bpsNum = parseInt(bps, 10);
        if (!Number.isFinite(bpsNum) || bpsNum <= 0 || bpsNum > 10000) {
            setError('bps must be between 1 and 10000');
            return;
        }
        setBusy(true);
        try {
            setStatus('Loading pool state...');
            const ctx = await loadCtx(ephemeral);

            const tx = new Transaction();
            if (ctx.needsAtaXIx) {
                tx.add(createAssociatedTokenAccountIdempotentInstruction(
                    ephemeral.publicKey, ctx.userTokenX, ephemeral.publicKey, ctx.tokenXMint
                ));
            }
            if (ctx.needsAtaYIx) {
                tx.add(createAssociatedTokenAccountIdempotentInstruction(
                    ephemeral.publicKey, ctx.userTokenY, ephemeral.publicKey, ctx.tokenYMint
                ));
            }
            tx.add(buildRemoveLiquidityIx(
                {
                    nonce,
                    fromBinId: ctx.lowerBinId,
                    toBinId: ctx.upperBinId,
                    bpsToRemove: bpsNum,
                },
                {
                    payer: ephemeral.publicKey,
                    position,
                    lbPair,
                    binArrayBitmapExtension: ctx.bitmapExists ? ctx.bitmapExt : METEORA_DLMM_PROGRAM_ID,
                    userTokenX: ctx.userTokenX,
                    userTokenY: ctx.userTokenY,
                    reserveX: ctx.reserveX,
                    reserveY: ctx.reserveY,
                    tokenXMint: ctx.tokenXMint,
                    tokenYMint: ctx.tokenYMint,
                    binArrayLower: ctx.binArrayLower,
                    binArrayUpper: ctx.binArrayUpper,
                    tokenXProgram: TOKEN_PROGRAM_ID,
                    tokenYProgram: TOKEN_PROGRAM_ID,
                }
            ));

            if (closeAfter) {
                tx.add(buildClosePositionIx(
                    {nonce},
                    {
                        payer: ephemeral.publicKey,
                        position,
                        lbPair,
                        binArrayLower: ctx.binArrayLower,
                        binArrayUpper: ctx.binArrayUpper,
                        rentReceiver: ephemeral.publicKey,
                    }
                ));
            }

            setStatus(closeAfter ? 'Removing liquidity + closing...' : 'Removing liquidity...');
            const sig = await sendAsEphemeral(ephemeral, tx);
            setStatus(`Done: ${sig}`);
            onChanged?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [publicKey, nonce, ephemeral, bps, lbPair, position, loadCtx, sendAsEphemeral, onChanged]);

    if (!ephemeral) return null;

    return (
        <div className="bg-base-300 rounded p-2 mt-2 space-y-2">
            <div className="flex items-center gap-2 text-xs">
                <span className="opacity-70">remove</span>
                <input
                    type="number"
                    min={1}
                    max={10000}
                    step={100}
                    className="input input-bordered input-xs w-24"
                    value={bps}
                    onChange={e => setBps(e.target.value)}
                />
                <span className="opacity-70">bps ({(parseInt(bps, 10) / 100).toFixed(0)}%)</span>
            </div>
            <div className="flex flex-wrap gap-1">
                <button
                    onClick={claim}
                    disabled={busy}
                    className="btn btn-xs"
                >
                    Claim fees
                </button>
                <button
                    onClick={() => void remove(false)}
                    disabled={busy}
                    className="btn btn-xs"
                >
                    Remove
                </button>
                <button
                    onClick={() => void remove(true)}
                    disabled={busy}
                    className="btn btn-xs btn-warning"
                >
                    Remove + close
                </button>
            </div>
            {status && <p className="text-success text-xs break-all">{status}</p>}
            {error && <p className="text-error text-xs break-all">{error}</p>}
        </div>
    );
}

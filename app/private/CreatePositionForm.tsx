// app/private/CreatePositionForm.tsx
//
// Connects a wallet, asks for a one-time signature to derive the user's
// master seed, and lets them open a fresh DLMM position whose owner is a
// per-user-per-position PDA of dlmm-private-wrap.
//
// v1 scope: opens an empty position. Adding liquidity is a follow-up flow.

'use client';

import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useConnection, useWallet} from '@solana/wallet-adapter-react';
import {WalletMultiButton} from '@solana/wallet-adapter-react-ui';
import {Keypair, PublicKey, Transaction} from '@solana/web3.js';
import {
    buildInitPositionIx,
    deriveEphemeralKeypair,
    deriveNonceFromSignature,
    derivePositionOwner,
    NONCE_DERIVATION_MESSAGE,
} from '@/app/utils/privateWrap';

const SIG_STORAGE_KEY = 'privateWrapMasterSig';
const INDEX_STORAGE_KEY = 'privateWrapNextIndex';

interface Props {
    onCreated?: (positionPubkey: PublicKey) => void;
}

export default function CreatePositionForm({onCreated}: Props) {
    const {connection} = useConnection();
    const {publicKey, signMessage, connected} = useWallet();

    const [masterSig, setMasterSig] = useState<Uint8Array | null>(null);
    const [nextIndex, setNextIndex] = useState<number>(0);

    const [lbPair, setLbPair] = useState('');
    const [lowerBinId, setLowerBinId] = useState('-34');
    const [width, setWidth] = useState('69');

    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string>('');
    const [error, setError] = useState<string>('');

    useEffect(() => {
        const sigHex = localStorage.getItem(SIG_STORAGE_KEY);
        if (sigHex) setMasterSig(new Uint8Array(Buffer.from(sigHex, 'hex')));
        const idx = localStorage.getItem(INDEX_STORAGE_KEY);
        if (idx) setNextIndex(parseInt(idx, 10) || 0);
    }, []);

    const unlock = useCallback(async () => {
        if (!signMessage) {
            setError('Connected wallet does not support message signing');
            return;
        }
        try {
            const sig = await signMessage(new TextEncoder().encode(NONCE_DERIVATION_MESSAGE));
            setMasterSig(sig);
            localStorage.setItem(SIG_STORAGE_KEY, Buffer.from(sig).toString('hex'));
            setError('');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [signMessage]);

    const ephemeral: Keypair | null = useMemo(
        () => (masterSig ? deriveEphemeralKeypair(masterSig) : null),
        [masterSig]
    );

    const submit = useCallback(async () => {
        setError('');
        setStatus('');
        if (!publicKey) {
            setError('Connect a wallet first');
            return;
        }
        if (!masterSig || !ephemeral) {
            setError('Sign the unlock message first');
            return;
        }
        if (!lbPair) {
            setError('Enter the LB pair address');
            return;
        }

        let lbPairKey: PublicKey;
        try {
            lbPairKey = new PublicKey(lbPair);
        } catch {
            setError('Invalid LB pair address');
            return;
        }
        const lower = parseInt(lowerBinId, 10);
        const w = parseInt(width, 10);
        if (!Number.isFinite(lower) || !Number.isFinite(w) || w <= 0) {
            setError('Lower bin id must be an integer; width must be a positive integer');
            return;
        }

        setBusy(true);
        try {
            const nonce = deriveNonceFromSignature(masterSig, nextIndex);
            const positionKp = Keypair.generate();

            // Ephemeral pays the rent and signs the wrapper call. The
            // connected wallet does not appear on this transaction.
            const ix = buildInitPositionIx(
                {nonce, lowerBinId: lower, width: w},
                {
                    payer: ephemeral.publicKey,
                    position: positionKp.publicKey,
                    lbPair: lbPairKey,
                }
            );

            const tx = new Transaction().add(ix);
            tx.feePayer = ephemeral.publicKey;
            const {blockhash, lastValidBlockHeight} = await connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.sign(ephemeral, positionKp);

            setStatus('Submitting (signed by ephemeral)...');
            const sig = await connection.sendRawTransaction(tx.serialize(), {
                skipPreflight: false,
            });

            setStatus(`Submitted: ${sig}. Confirming...`);
            const conf = await connection.confirmTransaction(
                {signature: sig, blockhash, lastValidBlockHeight},
                'confirmed'
            );
            if (conf.value.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);

            const newIndex = nextIndex + 1;
            setNextIndex(newIndex);
            localStorage.setItem(INDEX_STORAGE_KEY, String(newIndex));
            const [owner] = derivePositionOwner(nonce);
            setStatus(
                `Position opened. PDA owner: ${owner.toBase58().slice(0, 8)}…  Position: ${positionKp.publicKey.toBase58().slice(0, 8)}…`
            );
            onCreated?.(positionKp.publicKey);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [connection, publicKey, masterSig, ephemeral, nextIndex, lbPair, lowerBinId, width, onCreated]);

    return (
        <div className="bg-base-200 rounded-box p-4 space-y-3">
            <div className="flex items-center justify-between">
                <h2 className="font-semibold">Open a private position</h2>
                <WalletMultiButton style={{height: '32px', fontSize: '12px'}}/>
            </div>

            {!connected ? (
                <p className="text-sm opacity-70">Connect a wallet to start.</p>
            ) : !masterSig ? (
                <div className="space-y-2">
                    <p className="text-sm opacity-70">
                        Sign a one-time message to derive your private-position keys. This
                        signature never leaves your browser. The same wallet on any device
                        will recover your positions.
                    </p>
                    <button onClick={unlock} className="btn btn-primary btn-sm">
                        Sign unlock message
                    </button>
                </div>
            ) : (
                <div className="space-y-2 text-sm">
                    <div className="text-xs opacity-60">
                        next position index: <span className="font-mono">{nextIndex}</span>
                    </div>

                    <label className="block">
                        <span className="opacity-70">LB pair address</span>
                        <input
                            type="text"
                            className="input input-bordered input-sm w-full font-mono text-xs mt-1"
                            placeholder="Meteora LB pair pubkey"
                            value={lbPair}
                            onChange={e => setLbPair(e.target.value)}
                        />
                    </label>

                    <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                            <span className="opacity-70">Lower bin id</span>
                            <input
                                type="number"
                                className="input input-bordered input-sm w-full mt-1"
                                value={lowerBinId}
                                onChange={e => setLowerBinId(e.target.value)}
                            />
                        </label>
                        <label className="block">
                            <span className="opacity-70">Width (bins)</span>
                            <input
                                type="number"
                                className="input input-bordered input-sm w-full mt-1"
                                value={width}
                                onChange={e => setWidth(e.target.value)}
                            />
                        </label>
                    </div>

                    <button
                        onClick={submit}
                        className="btn btn-accent btn-sm w-full"
                        disabled={busy}
                    >
                        {busy ? <span className="loading loading-spinner loading-xs"/> : 'Open position'}
                    </button>

                    <p className="text-xs opacity-60">
                        v1 opens an empty position. Add liquidity in a follow-up step from
                        the position list below.
                    </p>
                </div>
            )}

            {status && <p className="text-success text-xs break-all">{status}</p>}
            {error && <p className="text-error text-xs break-all">{error}</p>}
        </div>
    );
}

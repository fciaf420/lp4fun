// app/private/page.tsx
//
// Private DLMM position dashboard. Connects a wallet, unlocks a master
// signature, and lets the user open new wrapped positions or browse
// existing ones (derived from the signature, so a wallet alone is enough
// to recover them on any device).

'use client';

import React, {useCallback, useEffect, useMemo, useState} from 'react';
import Link from 'next/link';
import {useConnection, useWallet} from '@solana/wallet-adapter-react';
import {WalletMultiButton} from '@solana/wallet-adapter-react-ui';
import {PublicKey} from '@solana/web3.js';
import CreatePositionForm from './CreatePositionForm';
import AddLiquidityForm from './AddLiquidityForm';
import PositionActions from './PositionActions';
import ShieldForm from './ShieldForm';
import {
    deriveNonceFromSignature,
    derivePositionOwner,
    findPositionsForNonces,
    FoundPosition,
    NONCE_DERIVATION_MESSAGE,
} from '@/app/utils/privateWrap';

const SIG_STORAGE_KEY = 'privateWrapMasterSig';
const INDEX_STORAGE_KEY = 'privateWrapNextIndex';

interface PositionRow {
    index: number;
    owner: PublicKey;
    positions: FoundPosition[];
}

export default function PrivatePage() {
    const {connection} = useConnection();
    const {connected, signMessage, publicKey} = useWallet();

    const [masterSig, setMasterSig] = useState<Uint8Array | null>(null);
    const [nextIndex, setNextIndex] = useState<number>(0);

    const [rows, setRows] = useState<PositionRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

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

    const knownNonces = useMemo(() => {
        if (!masterSig) return [];
        const out: { index: number; nonce: Uint8Array }[] = [];
        // Look one past nextIndex so a freshly-opened position shows up even
        // if the local counter is one stale.
        const horizon = Math.max(nextIndex + 1, 1);
        for (let i = 0; i < horizon; i++) {
            out.push({index: i, nonce: deriveNonceFromSignature(masterSig, i)});
        }
        return out;
    }, [masterSig, nextIndex]);

    const refresh = useCallback(async () => {
        if (knownNonces.length === 0) return;
        setLoading(true);
        setError('');
        try {
            const found = await findPositionsForNonces(
                connection,
                knownNonces.map(n => n.nonce)
            );
            setRows(found.map((f, i) => ({
                index: knownNonces[i].index,
                owner: f.owner,
                positions: f.positions,
            })));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, [connection, knownNonces]);

    return (
        <div className="max-w-3xl mx-auto p-4 space-y-6 w-full">
            <div>
                <h1 className="text-2xl font-bold">Private DLMM positions</h1>
                <p className="text-sm opacity-70 mt-1">
                    Each of your positions is owned by a per-position PDA derived from a
                    one-time signature. Bots watching your wallet see nothing — only the
                    PDA appears on-chain.
                </p>
            </div>

            {!connected && (
                <div className="bg-base-200 rounded-box p-4 flex items-center justify-between">
                    <span className="text-sm">Connect a wallet to begin.</span>
                    <WalletMultiButton style={{height: '32px', fontSize: '12px'}}/>
                </div>
            )}

            {connected && !masterSig && (
                <div className="bg-base-200 rounded-box p-4 space-y-2">
                    <h2 className="font-semibold">Unlock</h2>
                    <p className="text-sm opacity-70">
                        Sign a deterministic message once. The signature never leaves your
                        browser; it just derives the keys for your private positions. The
                        same wallet on any device recovers the same positions.
                    </p>
                    <p className="text-xs opacity-60 font-mono break-all">
                        message: &quot;{NONCE_DERIVATION_MESSAGE}&quot;
                    </p>
                    <button onClick={unlock} className="btn btn-primary btn-sm">
                        Sign unlock message
                    </button>
                </div>
            )}

            {connected && masterSig && (
                <>
                    <ShieldForm/>

                    <CreatePositionForm
                        onCreated={() => {
                            // bump local cursor and re-list
                            const next = nextIndex + 1;
                            setNextIndex(next);
                            localStorage.setItem(INDEX_STORAGE_KEY, String(next));
                            void refresh();
                        }}
                    />

                    <div className="bg-base-200 rounded-box p-4 space-y-3">
                        <div className="flex items-center justify-between">
                            <h2 className="font-semibold">Your positions</h2>
                            <button
                                onClick={refresh}
                                disabled={loading}
                                className="btn btn-sm btn-ghost"
                            >
                                {loading ? <span className="loading loading-spinner loading-xs"/> : 'Refresh'}
                            </button>
                        </div>

                        {publicKey && (
                            <p className="text-xs opacity-60 font-mono break-all">
                                wallet: {publicKey.toBase58()}
                            </p>
                        )}

                        {rows.length === 0 ? (
                            <p className="text-sm opacity-60">
                                No positions yet — or click Refresh.
                            </p>
                        ) : (
                            <ul className="space-y-3">
                                {rows.map(r => (
                                    <li key={r.index} className="text-sm">
                                        <div className="flex items-baseline justify-between">
                                            <span className="font-medium">position #{r.index}</span>
                                            <span className="text-xs opacity-60 font-mono truncate max-w-[60%]">
                                                pda: {r.owner.toBase58()}
                                            </span>
                                        </div>
                                        {r.positions.length === 0 ? (
                                            <div className="text-xs opacity-50">no on-chain position yet</div>
                                        ) : (
                                            <ul className="text-xs font-mono space-y-2 mt-1 ml-2">
                                                {r.positions.map(p => (
                                                    <li key={p.pubkey.toBase58()}>
                                                        <Link
                                                            href={`/position/${p.pubkey.toBase58()}`}
                                                            className="link link-primary"
                                                        >
                                                            {p.pubkey.toBase58()}
                                                        </Link>
                                                        <AddLiquidityForm
                                                            index={r.index}
                                                            position={p.pubkey}
                                                            lbPair={p.lbPair}
                                                            onDone={refresh}
                                                        />
                                                        <PositionActions
                                                            index={r.index}
                                                            position={p.pubkey}
                                                            lbPair={p.lbPair}
                                                            onChanged={refresh}
                                                        />
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}

                        {error && <p className="text-error text-xs break-all">{error}</p>}
                    </div>

                    <details className="bg-base-200 rounded-box p-4">
                        <summary className="cursor-pointer text-sm font-semibold">
                            Recovery / privacy notes
                        </summary>
                        <ul className="text-xs opacity-70 mt-2 space-y-1 list-disc list-inside">
                            <li>
                                Your master signature lives in localStorage. Wiping it is
                                fine — sign the same message again to recover.
                            </li>
                            <li>
                                Positions are owned by per-position PDAs, not your wallet.
                                Bots watching your wallet see nothing, but anyone watching
                                this program will still see the PDAs operating. Privacy
                                comes from the anonymity set of users on the program.
                            </li>
                            <li>
                                When you withdraw / claim fees, route the tokens to a fresh
                                account, not your main wallet, or you re-link everything.
                            </li>
                        </ul>
                    </details>
                </>
            )}
        </div>
    );
}

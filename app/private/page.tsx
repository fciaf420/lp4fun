// app/private/page.tsx
//
// Manages the user's local list of nonces (each one corresponds to a
// position-owner PDA of dlmm-private-wrap) and lists every DLMM Position
// account currently held under those PDAs.
//
// Nothing here signs a transaction or creates a position — that requires a
// wallet-adapter integration that lp4fun doesn't have yet. This page is the
// analytics counterpart to the wrapper program: it lets you see your own
// wrapped positions even though they aren't owned by your wallet.

'use client';

import React, {useEffect, useMemo, useState} from 'react';
import Link from 'next/link';
import {Connection, PublicKey} from '@solana/web3.js';
import {
    derivePositionOwner,
    findPositionsForNonces,
    newNonce,
    nonceFromHex,
    nonceToHex,
} from '@/app/utils/privateWrap';
import {getDefaultConnection} from '@/app/utils/cachedConnection';

const STORAGE_KEY = 'privateWrapNonces';

interface NonceEntry {
    label: string;
    hex: string;
}

interface FoundPosition {
    nonce: NonceEntry;
    owner: PublicKey;
    positions: PublicKey[];
}

export default function PrivatePage() {
    const [entries, setEntries] = useState<NonceEntry[]>([]);
    const [label, setLabel] = useState('');
    const [importHex, setImportHex] = useState('');
    const [importError, setImportError] = useState('');
    const [results, setResults] = useState<FoundPosition[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const connection: Connection = useMemo(() => getDefaultConnection(), []);

    useEffect(() => {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            try {
                setEntries(JSON.parse(raw));
            } catch {
                // ignore bad localStorage
            }
        }
    }, []);

    function persist(next: NonceEntry[]) {
        setEntries(next);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }

    function addGenerated() {
        const trimmed = label.trim() || `position-${entries.length + 1}`;
        const hex = nonceToHex(newNonce());
        persist([...entries, {label: trimmed, hex}]);
        setLabel('');
    }

    function importNonce() {
        try {
            // validate
            nonceFromHex(importHex.trim());
            const trimmed = label.trim() || `imported-${entries.length + 1}`;
            persist([...entries, {label: trimmed, hex: importHex.trim()}]);
            setImportHex('');
            setLabel('');
            setImportError('');
        } catch (e) {
            setImportError(e instanceof Error ? e.message : String(e));
        }
    }

    function removeAt(idx: number) {
        if (!confirm('Remove this nonce? You will lose access to the position unless you have it backed up.')) return;
        const next = [...entries];
        next.splice(idx, 1);
        persist(next);
    }

    async function lookup() {
        setLoading(true);
        setError('');
        setResults([]);
        try {
            const found = await findPositionsForNonces(
                connection,
                entries.map(e => nonceFromHex(e.hex))
            );
            setResults(
                found.map((f, i) => ({
                    nonce: entries[i],
                    owner: f.owner,
                    positions: f.positions,
                }))
            );
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="max-w-3xl mx-auto p-4 space-y-6">
            <div>
                <h1 className="text-2xl font-bold">Private DLMM positions</h1>
                <p className="text-sm opacity-70 mt-1">
                    Positions wrapped by <code>dlmm-private-wrap</code> are owned by a PDA
                    derived from a 32-byte nonce. Anyone who knows the nonce controls the
                    position — these never leave your browser.
                </p>
            </div>

            <div className="bg-base-200 rounded-box p-4 space-y-3">
                <h2 className="font-semibold">Add a nonce</h2>
                <input
                    type="text"
                    className="input input-bordered w-full"
                    placeholder="Label (optional)"
                    value={label}
                    onChange={e => setLabel(e.target.value)}
                />
                <div className="flex gap-2">
                    <button onClick={addGenerated} className="btn btn-primary flex-1">
                        Generate new nonce
                    </button>
                </div>
                <div className="divider text-xs opacity-50">or import existing</div>
                <input
                    type="text"
                    className="input input-bordered w-full font-mono text-xs"
                    placeholder="64 hex chars"
                    value={importHex}
                    onChange={e => setImportHex(e.target.value)}
                />
                <button onClick={importNonce} className="btn btn-secondary w-full">
                    Import nonce
                </button>
                {importError && <p className="text-error text-sm">{importError}</p>}
            </div>

            <div className="bg-base-200 rounded-box p-4 space-y-3">
                <div className="flex justify-between items-center">
                    <h2 className="font-semibold">Stored nonces ({entries.length})</h2>
                    <button
                        onClick={lookup}
                        className="btn btn-accent btn-sm"
                        disabled={loading || entries.length === 0}
                    >
                        {loading ? <span className="loading loading-spinner loading-xs"/> : 'Find positions'}
                    </button>
                </div>
                {entries.length === 0 ? (
                    <p className="text-sm opacity-60">No nonces stored yet.</p>
                ) : (
                    <ul className="space-y-2">
                        {entries.map((e, i) => {
                            const [owner] = derivePositionOwner(nonceFromHex(e.hex));
                            return (
                                <li key={i} className="flex items-start gap-3 text-sm">
                                    <div className="flex-1 min-w-0">
                                        <div className="font-medium">{e.label}</div>
                                        <div className="text-xs opacity-60 truncate font-mono">
                                            nonce: {e.hex}
                                        </div>
                                        <div className="text-xs opacity-60 truncate font-mono">
                                            owner: {owner.toBase58()}
                                        </div>
                                    </div>
                                    <button onClick={() => removeAt(i)} className="btn btn-ghost btn-xs">
                                        remove
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
                {error && <p className="text-error text-sm">{error}</p>}
            </div>

            {results.length > 0 && (
                <div className="bg-base-200 rounded-box p-4 space-y-3">
                    <h2 className="font-semibold">Wrapped positions</h2>
                    {results.map((r, i) => (
                        <div key={i} className="border-b border-base-300 last:border-b-0 pb-2 last:pb-0">
                            <div className="text-sm font-medium">{r.nonce.label}</div>
                            {r.positions.length === 0 ? (
                                <div className="text-xs opacity-60">no positions yet</div>
                            ) : (
                                <ul className="text-xs font-mono space-y-1 mt-1">
                                    {r.positions.map(p => (
                                        <li key={p.toBase58()}>
                                            <Link
                                                href={`/position/${p.toBase58()}`}
                                                className="link link-primary"
                                            >
                                                {p.toBase58()}
                                            </Link>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

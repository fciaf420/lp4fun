// app/private/PrivateProviders.tsx
//
// Wraps the /private subtree with the Solana wallet adapter context.
// Lets the user paste their own RPC URL — important here because many
// public RPCs sell mempool/position data to copy traders, defeating the
// privacy point.

'use client';

import React, {useEffect, useMemo, useState} from 'react';
import {ConnectionProvider, WalletProvider} from '@solana/wallet-adapter-react';
import {WalletModalProvider} from '@solana/wallet-adapter-react-ui';
import {PhantomWalletAdapter, SolflareWalletAdapter} from '@solana/wallet-adapter-wallets';

import '@solana/wallet-adapter-react-ui/styles.css';

const RPC_STORAGE_KEY = 'privateWrapRpc';
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

export default function PrivateProviders({children}: { children: React.ReactNode }) {
    const [rpc, setRpc] = useState<string>(DEFAULT_RPC);
    const [draft, setDraft] = useState<string>(DEFAULT_RPC);
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
        const stored = localStorage.getItem(RPC_STORAGE_KEY);
        const initial = stored
            || process.env.NEXT_PUBLIC_SOLANA_RPC
            || DEFAULT_RPC;
        setRpc(initial);
        setDraft(initial);
        setHydrated(true);
    }, []);

    function applyRpc() {
        const trimmed = draft.trim();
        if (!trimmed) return;
        try {
            // sanity-check the URL
            // eslint-disable-next-line no-new
            new URL(trimmed);
        } catch {
            alert('Invalid RPC URL');
            return;
        }
        localStorage.setItem(RPC_STORAGE_KEY, trimmed);
        setRpc(trimmed);
    }

    const wallets = useMemo(
        () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
        []
    );

    if (!hydrated) return null;

    return (
        <ConnectionProvider endpoint={rpc} key={rpc}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>
                    <div className="bg-base-200 border-b border-base-300 px-4 py-2 text-xs">
                        <div className="max-w-3xl mx-auto flex flex-wrap items-center gap-2">
                            <span className="opacity-70">RPC:</span>
                            <input
                                type="text"
                                className="input input-bordered input-xs flex-1 min-w-0 font-mono"
                                placeholder="https://your-rpc..."
                                value={draft}
                                onChange={e => setDraft(e.target.value)}
                            />
                            <button
                                onClick={applyRpc}
                                className="btn btn-xs btn-primary"
                                disabled={draft.trim() === rpc}
                            >
                                Use this RPC
                            </button>
                            <span className="opacity-50">
                                (use a private RPC; public ones leak mempool data)
                            </span>
                        </div>
                    </div>
                    {children}
                </WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    );
}

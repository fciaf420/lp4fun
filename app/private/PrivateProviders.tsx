// app/private/PrivateProviders.tsx
//
// Wraps the /private subtree with the Solana wallet adapter context. Kept
// in a separate client component so we don't have to convert the whole app
// layout to client-rendered.

'use client';

import React, {useMemo} from 'react';
import {ConnectionProvider, WalletProvider} from '@solana/wallet-adapter-react';
import {WalletModalProvider} from '@solana/wallet-adapter-react-ui';
import {PhantomWalletAdapter, SolflareWalletAdapter} from '@solana/wallet-adapter-wallets';
import {clusterApiUrl} from '@solana/web3.js';

import '@solana/wallet-adapter-react-ui/styles.css';

export default function PrivateProviders({children}: { children: React.ReactNode }) {
    // Default to devnet for the create flow until the wrapper program is
    // deployed + audited on mainnet. Override via NEXT_PUBLIC_SOLANA_RPC.
    const endpoint = useMemo(
        () => process.env.NEXT_PUBLIC_SOLANA_RPC || clusterApiUrl('devnet'),
        []
    );

    const wallets = useMemo(
        () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
        []
    );

    return (
        <ConnectionProvider endpoint={endpoint}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>{children}</WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    );
}

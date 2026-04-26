// app/private/ShieldForm.tsx
//
// Two-step funding flow for the ephemeral signer:
//   1. Shield: deposit SOL from the connected wallet into PrivacyCash's pool.
//      The connected wallet is the signer of the on-chain deposit tx.
//   2. Unshield: withdraw SOL from the pool to the ephemeral signer pubkey.
//      The PrivacyCash relayer is the signer of the on-chain tx — the
//      connected wallet does NOT appear on this transaction. That's the
//      cryptographic break that copy-LP bots cannot trace.
//
// Privacy property: a bot watching the connected wallet sees one deposit
// to PrivacyCash and nothing else. Subsequent LP activity, signed by the
// ephemeral, has no on-chain link to the connected wallet.

'use client';

import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useConnection, useWallet} from '@solana/wallet-adapter-react';
import {LAMPORTS_PER_SOL, Keypair} from '@solana/web3.js';
import {deriveEphemeralKeypair} from '@/app/utils/privateWrap';
import {
    buildEncryptionService,
    getShieldedSolBalance,
    PC_SIGN_MESSAGE,
    shieldSol,
    unshieldSol,
} from '@/app/utils/privacyCash';

const SIG_STORAGE_KEY = 'privateWrapMasterSig';

interface Balances {
    walletSol: number;
    ephemeralSol: number;
    shieldedSol: number;
}

export default function ShieldForm() {
    const {connection} = useConnection();
    const {publicKey, signMessage, signTransaction} = useWallet();

    const [masterSig, setMasterSig] = useState<Uint8Array | null>(null);
    const [balances, setBalances] = useState<Balances>({walletSol: 0, ephemeralSol: 0, shieldedSol: 0});
    const [shieldAmount, setShieldAmount] = useState('0.05');
    const [unshieldAmount, setUnshieldAmount] = useState('0.05');
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

    const refresh = useCallback(async () => {
        if (!publicKey || !ephemeral || !signMessage) return;
        setError('');
        try {
            const [walletLamports, ephLamports] = await Promise.all([
                connection.getBalance(publicKey),
                connection.getBalance(ephemeral.publicKey),
            ]);
            // Shielded balance requires the encryption service; load lazily.
            let shielded = 0;
            try {
                const svc = await buildEncryptionService(signMessage);
                const bal = await getShieldedSolBalance({
                    connection,
                    walletPubkey: publicKey,
                    encryptionService: svc,
                });
                shielded = Number(bal.lamports ?? 0);
            } catch {
                // shielded read may fail without prior init; not fatal
            }
            setBalances({
                walletSol: walletLamports / LAMPORTS_PER_SOL,
                ephemeralSol: ephLamports / LAMPORTS_PER_SOL,
                shieldedSol: shielded / LAMPORTS_PER_SOL,
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [connection, publicKey, ephemeral, signMessage]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const shield = useCallback(async () => {
        if (!publicKey || !signMessage || !signTransaction) {
            setError('Connect wallet');
            return;
        }
        const lamports = Math.floor(parseFloat(shieldAmount) * LAMPORTS_PER_SOL);
        if (!Number.isFinite(lamports) || lamports <= 0) {
            setError('Invalid amount');
            return;
        }
        setBusy(true);
        setError('');
        setStatus('Deriving encryption key (sign request)...');
        try {
            const svc = await buildEncryptionService(signMessage);
            setStatus('Generating ZK proof + shielding (this takes ~10s)...');
            const res = await shieldSol({
                connection,
                walletPubkey: publicKey,
                encryptionService: svc,
                signTransaction,
                lamports,
            });
            setStatus(`Shielded. Tx: ${typeof res === 'string' ? res : 'submitted'}`);
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [connection, publicKey, signMessage, signTransaction, shieldAmount, refresh]);

    const unshield = useCallback(async () => {
        if (!publicKey || !signMessage || !ephemeral) {
            setError('Connect wallet');
            return;
        }
        const lamports = Math.floor(parseFloat(unshieldAmount) * LAMPORTS_PER_SOL);
        if (!Number.isFinite(lamports) || lamports <= 0) {
            setError('Invalid amount');
            return;
        }
        setBusy(true);
        setError('');
        setStatus('Deriving encryption key (sign request)...');
        try {
            const svc = await buildEncryptionService(signMessage);
            setStatus('Generating ZK proof + relaying withdraw (this takes ~10s)...');
            const res = await unshieldSol({
                connection,
                walletPubkey: publicKey,
                encryptionService: svc,
                recipient: ephemeral.publicKey,
                lamports,
            });
            setStatus(`Unshielded to ephemeral. Sig: ${typeof res === 'string' ? res : 'submitted'}`);
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [connection, publicKey, signMessage, ephemeral, unshieldAmount, refresh]);

    if (!ephemeral) {
        return (
            <div className="bg-base-200 rounded-box p-4 text-sm opacity-70">
                Sign the unlock message above to enable shielded funding.
            </div>
        );
    }

    return (
        <div className="bg-base-200 rounded-box p-4 space-y-3">
            <div className="flex items-baseline justify-between">
                <h2 className="font-semibold">Shielded funding</h2>
                <button
                    onClick={refresh}
                    className="btn btn-ghost btn-xs"
                    disabled={busy}
                >
                    Refresh
                </button>
            </div>

            <div className="text-xs space-y-1 font-mono">
                <div>connected wallet: <span className="opacity-70">{publicKey?.toBase58()}</span></div>
                <div>ephemeral signer: <span className="opacity-70">{ephemeral.publicKey.toBase58()}</span></div>
            </div>

            <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="bg-base-300 rounded p-2">
                    <div className="opacity-60">wallet SOL</div>
                    <div className="font-mono">{balances.walletSol.toFixed(4)}</div>
                </div>
                <div className="bg-base-300 rounded p-2">
                    <div className="opacity-60">shielded SOL</div>
                    <div className="font-mono">{balances.shieldedSol.toFixed(4)}</div>
                </div>
                <div className="bg-base-300 rounded p-2">
                    <div className="opacity-60">ephemeral SOL</div>
                    <div className="font-mono">{balances.ephemeralSol.toFixed(4)}</div>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                    <div className="text-xs opacity-70">1. Shield from wallet</div>
                    <input
                        type="number"
                        step="0.01"
                        className="input input-bordered input-sm w-full"
                        value={shieldAmount}
                        onChange={e => setShieldAmount(e.target.value)}
                    />
                    <button
                        onClick={shield}
                        disabled={busy}
                        className="btn btn-sm btn-primary w-full"
                    >
                        Shield SOL
                    </button>
                </div>
                <div className="space-y-1">
                    <div className="text-xs opacity-70">2. Unshield to ephemeral</div>
                    <input
                        type="number"
                        step="0.01"
                        className="input input-bordered input-sm w-full"
                        value={unshieldAmount}
                        onChange={e => setUnshieldAmount(e.target.value)}
                    />
                    <button
                        onClick={unshield}
                        disabled={busy || balances.shieldedSol <= 0}
                        className="btn btn-sm btn-secondary w-full"
                    >
                        Unshield to ephemeral
                    </button>
                </div>
            </div>

            <p className="text-xs opacity-60">
                For best privacy, wait between steps 1 and 2 — anonymity scales
                with the number of other deposits in the pool between yours and
                your withdrawal. Withdraws do not appear in your wallet&apos;s tx
                history; PrivacyCash&apos;s relayer signs the on-chain tx.
            </p>

            {status && <p className="text-success text-xs break-all">{status}</p>}
            {error && <p className="text-error text-xs break-all">{error}</p>}
        </div>
    );
}

// app/utils/privacyCash.ts
//
// Browser-side wrapper around the `privacycash` SDK. The published SDK ships
// a high-level `PrivacyCash` class designed for Node (it takes a private key
// in the constructor and reads circuit files via `node:path`). We bypass it
// and call the lower-level `deposit`/`withdraw` functions directly so we can:
//
//   - derive the encryption key from a wallet-adapter `signMessage` (no
//     private-key handling in the browser),
//   - sign deposit txs with the connected wallet via `signTransaction`,
//   - load circuit artifacts from `/public/privacycash/` over fetch (snarkjs
//     accepts URL strings),
//   - use `window.localStorage` directly as the SDK's `storage` parameter.
//
// Withdraws are submitted by PrivacyCash's relayer (`api3.privacycash.org`),
// so the connected wallet does NOT sign the withdraw tx. Unshielded SOL
// lands on the recipient (our ephemeral signer) with no on-chain link to
// the depositing wallet.

'use client';

import {Connection, PublicKey, VersionedTransaction} from '@solana/web3.js';
import {WasmFactory} from '@lightprotocol/hasher.rs';
import {deposit, withdraw, getUtxos, getBalanceFromUtxos, EncryptionService} from 'privacycash/utils';

/** Path under `public/` where postinstall copies the circuit artifacts. */
const CIRCUIT_BASE_PATH = '/privacycash/transaction2';

/**
 * Message the user signs once to derive their PrivacyCash encryption identity.
 * The signature itself never leaves the browser. Same wallet on any device →
 * same encryption identity → same UTXOs.
 */
export const PC_SIGN_MESSAGE = 'lp4fun-privacycash-v1';

function browserStorage(): Storage {
    if (typeof window === 'undefined') {
        throw new Error('PrivacyCash helpers must run in the browser');
    }
    return window.localStorage;
}

export type WalletSignMessageFn = (msg: Uint8Array) => Promise<Uint8Array>;
export type WalletSignTxFn = (tx: VersionedTransaction) => Promise<VersionedTransaction>;

/**
 * Build an EncryptionService bound to the connected wallet's signature over
 * `PC_SIGN_MESSAGE`. The service holds the encryption + UTXO spending keys
 * derived from that signature and is needed by every shield/unshield/balance
 * call.
 */
export async function buildEncryptionService(
    signMessage: WalletSignMessageFn
): Promise<EncryptionService> {
    const sig = await signMessage(new TextEncoder().encode(PC_SIGN_MESSAGE));
    const svc = new EncryptionService();
    svc.deriveEncryptionKeyFromSignature(sig);
    return svc;
}

export interface ShieldParams {
    connection: Connection;
    walletPubkey: PublicKey;
    encryptionService: EncryptionService;
    /** Wallet-adapter `signTransaction`. */
    signTransaction: WalletSignTxFn;
    lamports: number;
}

/**
 * Deposit SOL from the connected wallet into the PrivacyCash pool. The tx is
 * signed by the connected wallet and submitted via PrivacyCash's relayer.
 */
export async function shieldSol(p: ShieldParams) {
    const lightWasm = await WasmFactory.getInstance();
    return deposit({
        lightWasm,
        publicKey: p.walletPubkey,
        connection: p.connection,
        encryptionService: p.encryptionService,
        amount_in_lamports: p.lamports,
        transactionSigner: p.signTransaction,
        keyBasePath: CIRCUIT_BASE_PATH,
        storage: browserStorage(),
    });
}

export interface UnshieldParams {
    connection: Connection;
    /** Encryption identity (the depositor's wallet pubkey). */
    walletPubkey: PublicKey;
    encryptionService: EncryptionService;
    /** Where the unshielded SOL lands. Use a fresh / ephemeral pubkey. */
    recipient: PublicKey;
    lamports: number;
}

/**
 * Withdraw SOL from the PrivacyCash pool to `recipient`. The on-chain tx is
 * signed and submitted by PrivacyCash's relayer — the connected wallet is
 * NOT a signer on this transaction.
 */
export async function unshieldSol(p: UnshieldParams) {
    const lightWasm = await WasmFactory.getInstance();
    return withdraw({
        lightWasm,
        publicKey: p.walletPubkey,
        connection: p.connection,
        encryptionService: p.encryptionService,
        amount_in_lamports: p.lamports,
        recipient: p.recipient,
        keyBasePath: CIRCUIT_BASE_PATH,
        storage: browserStorage(),
    });
}

export interface BalanceParams {
    connection: Connection;
    walletPubkey: PublicKey;
    encryptionService: EncryptionService;
}

/** Returns the user's shielded SOL balance (in the PrivacyCash pool). */
export async function getShieldedSolBalance(p: BalanceParams) {
    const utxos = await getUtxos({
        publicKey: p.walletPubkey,
        connection: p.connection,
        encryptionService: p.encryptionService,
        storage: browserStorage(),
    });
    return getBalanceFromUtxos(utxos);
}

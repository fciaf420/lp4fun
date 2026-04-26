// app/utils/jito.ts
//
// Submit transactions through Jito's block-engine bundle endpoint instead
// of the public mempool. For a privacy product this matters because public
// RPC endpoints leak in-flight tx data to copy-trader bots before the tx
// even confirms.
//
// A Jito bundle is N transactions executed atomically and sequentially.
// One of them must include a transfer to a Jito tip account, otherwise the
// bundle is dropped. We expose:
//   - JITO_TIP_ACCOUNTS: known tip accounts
//   - addJitoTipIx(): build the tip transfer
//   - submitJitoBundle(): POST signed txs to the block engine
//
// References (verify against current Jito docs before mainnet):
//   https://docs.jito.wtf/lowlatencytxnsend/sendbundles/

import {PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * Jito's published mainnet tip accounts. Pick any one per bundle.
 * Refresh periodically — Jito rotates these.
 */
export const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pivKeVBBjQxAQ8EP4MUB',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
] as const;

export const JITO_BLOCK_ENGINE_MAINNET = 'https://mainnet.block-engine.jito.wtf';

export function pickJitoTipAccount(): PublicKey {
    const idx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return new PublicKey(JITO_TIP_ACCOUNTS[idx]);
}

/**
 * Build a tip transfer ix. Include this in one of the bundle's transactions.
 * `lamports` is the bid — typical values are 1000–100_000 depending on
 * congestion. Bundles below the current floor are dropped.
 */
export function addJitoTipIx(payer: PublicKey, lamports: number): TransactionInstruction {
    return SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: pickJitoTipAccount(),
        lamports,
    });
}

export interface SubmitBundleResult {
    bundleId: string;
}

/**
 * Submit a list of signed `VersionedTransaction`s as a Jito bundle.
 * One of the txs MUST include a `addJitoTipIx` to a Jito tip account, or
 * the bundle is silently dropped.
 *
 * Returns the bundleId on success. Use the inflight endpoint to poll
 * status if needed.
 */
export async function submitJitoBundle(
    txs: VersionedTransaction[],
    opts: { blockEngineUrl?: string; uuid?: string } = {}
): Promise<SubmitBundleResult> {
    const url = `${opts.blockEngineUrl ?? JITO_BLOCK_ENGINE_MAINNET}/api/v1/bundles${
        opts.uuid ? `?uuid=${encodeURIComponent(opts.uuid)}` : ''
    }`;

    const params = txs.map(tx => bs58.encode(tx.serialize()));

    const res = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendBundle',
            params: [params, {encoding: 'base58'}],
        }),
    });

    if (!res.ok) {
        throw new Error(`Jito bundle submission failed: ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    if (json.error) {
        throw new Error(`Jito error: ${JSON.stringify(json.error)}`);
    }
    return {bundleId: json.result as string};
}

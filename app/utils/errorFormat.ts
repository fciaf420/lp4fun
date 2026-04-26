// app/utils/errorFormat.ts
//
// Map common runtime errors from the Solana / Meteora / PrivacyCash stack
// into something a normal user can act on. Falls back to the raw message
// when nothing matches — never swallows the underlying error.

const PATTERNS: Array<{match: RegExp; message: string}> = [
    {
        match: /insufficient lamports|insufficient funds for rent/i,
        message:
            'Not enough SOL in the ephemeral wallet to pay for this transaction. Top up via shield + unshield.',
    },
    {
        match: /TransferHook|transfer_hook/i,
        message:
            'This pool uses Token-2022 with a Transfer Hook extension, which is not yet supported.',
    },
    {
        match: /could not find account|account not found|account does not exist/i,
        message:
            'A required account does not exist on chain. If this is a new pool, the bin array may need to be initialized; refresh and try again.',
    },
    {
        match: /blockhash not found|block height exceeded/i,
        message:
            'Network was busy and the transaction expired. Retry in a few seconds.',
    },
    {
        match: /User rejected|wallet.*rejected|user denied/i,
        message: 'Wallet signing was cancelled.',
    },
    {
        match: /signMessage is not (a function|implemented)/i,
        message:
            'This wallet does not support message signing. Use Phantom or Solflare on desktop.',
    },
    {
        match: /Don't deposit more than/i,
        message: 'Deposit exceeds PrivacyCash per-tx limit. Try a smaller amount.',
    },
    {
        match: /Need at least 1 unspent UTXO/i,
        message: 'No shielded balance to withdraw. Shield SOL first.',
    },
    {
        match: /Slippage|max active bin/i,
        message:
            'Active bin moved during your transaction (slippage). Increase max-slippage or retry.',
    },
];

/** Returns a user-friendly message; preserves the raw text under it. */
export function formatError(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e);
    for (const {match, message} of PATTERNS) {
        if (match.test(raw)) return message;
    }
    return raw;
}

// app/utils/privateWrap.ts
//
// Client-side helpers for the dlmm-private-wrap program. This file is the
// thin TS surface needed to:
//   - generate / store nonces (32 random bytes that act as the user's
//     "key" to a wrapped position)
//   - derive the position-owner PDA so the frontend can look up positions
//     held under it
//   - build the `init_position` instruction (the rest follow the same
//     pattern; left as TODO so the file stays small)
//
// SECURITY NOTE: the nonce IS the position's key. Anyone who learns it can
// drain that position. localStorage is convenient but not secure storage —
// for production, encrypt the nonce list with a wallet-signed key before
// persisting.

import {Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction} from '@solana/web3.js';
import {utils} from '@coral-xyz/anchor';

// Replace with the actual deployed program id once the program is built.
export const PRIVATE_WRAP_PROGRAM_ID = new PublicKey(
    'PrvWrap11111111111111111111111111111111111'
);

export const METEORA_DLMM_PROGRAM_ID = new PublicKey(
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'
);

const POSITION_OWNER_SEED = Buffer.from('pos');
const EVENT_AUTHORITY_SEED = Buffer.from('__event_authority');

/** 32 random bytes; persist somewhere safe and reversible. */
export function newNonce(): Uint8Array {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    return buf;
}

export function nonceToHex(nonce: Uint8Array): string {
    return Buffer.from(nonce).toString('hex');
}

export function nonceFromHex(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (clean.length !== 64) throw new Error('nonce must be 32 bytes (64 hex chars)');
    return new Uint8Array(Buffer.from(clean, 'hex'));
}

/** Derive the position-owner PDA: seeds = [b"pos", nonce]. */
export function derivePositionOwner(nonce: Uint8Array): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
        [POSITION_OWNER_SEED, Buffer.from(nonce)],
        PRIVATE_WRAP_PROGRAM_ID
    );
}

/** Meteora's event-authority PDA. */
export function deriveMeteoraEventAuthority(): PublicKey {
    return PublicKey.findProgramAddressSync(
        [EVENT_AUTHORITY_SEED],
        METEORA_DLMM_PROGRAM_ID
    )[0];
}

/** 8-byte Anchor sighash for `global:<name>`. */
function anchorSighash(name: string): Buffer {
    return Buffer.from(utils.sha256.hash(`global:${name}`), 'hex').subarray(0, 8);
}

/** Encodes the `init_position(nonce, lower_bin_id, width)` ix data. */
export function encodeInitPositionData(
    nonce: Uint8Array,
    lowerBinId: number,
    width: number
): Buffer {
    if (nonce.length !== 32) throw new Error('nonce must be 32 bytes');
    const buf = Buffer.alloc(8 + 32 + 4 + 4);
    anchorSighash('init_position').copy(buf, 0);
    Buffer.from(nonce).copy(buf, 8);
    buf.writeInt32LE(lowerBinId, 8 + 32);
    buf.writeInt32LE(width, 8 + 32 + 4);
    return buf;
}

export interface InitPositionAccounts {
    payer: PublicKey;
    /** Fresh keypair for the new DLMM Position account; signer on the tx. */
    position: PublicKey;
    lbPair: PublicKey;
}

/** Build the wrapper's `init_position` ix. */
export function buildInitPositionIx(
    args: { nonce: Uint8Array; lowerBinId: number; width: number },
    accounts: InitPositionAccounts
): TransactionInstruction {
    const [positionOwner] = derivePositionOwner(args.nonce);
    const eventAuthority = deriveMeteoraEventAuthority();

    return new TransactionInstruction({
        programId: PRIVATE_WRAP_PROGRAM_ID,
        keys: [
            {pubkey: accounts.payer, isSigner: true, isWritable: true},
            {pubkey: accounts.position, isSigner: true, isWritable: true},
            {pubkey: accounts.lbPair, isSigner: false, isWritable: false},
            {pubkey: positionOwner, isSigner: false, isWritable: false},
            {pubkey: eventAuthority, isSigner: false, isWritable: false},
            {pubkey: METEORA_DLMM_PROGRAM_ID, isSigner: false, isWritable: false},
            {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
            {pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false},
        ],
        data: encodeInitPositionData(args.nonce, args.lowerBinId, args.width),
    });
}

// ----- Liquidity / claim / close -----

/** Common accounts for the wrapper's add_liquidity / remove_liquidity ixs. */
export interface ManageLiquidityAccounts {
    payer: PublicKey;
    position: PublicKey;
    lbPair: PublicKey;
    binArrayBitmapExtension: PublicKey; // pass METEORA_DLMM_PROGRAM_ID if absent
    userTokenX: PublicKey;
    userTokenY: PublicKey;
    reserveX: PublicKey;
    reserveY: PublicKey;
    tokenXMint: PublicKey;
    tokenYMint: PublicKey;
    binArrayLower: PublicKey;
    binArrayUpper: PublicKey;
    tokenXProgram: PublicKey; // SPL Token or Token-2022
    tokenYProgram: PublicKey;
}

function manageLiquidityKeys(nonce: Uint8Array, a: ManageLiquidityAccounts) {
    const [positionOwner] = derivePositionOwner(nonce);
    const eventAuthority = deriveMeteoraEventAuthority();
    return [
        {pubkey: a.payer, isSigner: true, isWritable: true},
        {pubkey: positionOwner, isSigner: false, isWritable: false},
        {pubkey: a.position, isSigner: false, isWritable: true},
        {pubkey: a.lbPair, isSigner: false, isWritable: true},
        {pubkey: a.binArrayBitmapExtension, isSigner: false, isWritable: true},
        {pubkey: a.userTokenX, isSigner: false, isWritable: true},
        {pubkey: a.userTokenY, isSigner: false, isWritable: true},
        {pubkey: a.reserveX, isSigner: false, isWritable: true},
        {pubkey: a.reserveY, isSigner: false, isWritable: true},
        {pubkey: a.tokenXMint, isSigner: false, isWritable: false},
        {pubkey: a.tokenYMint, isSigner: false, isWritable: false},
        {pubkey: a.binArrayLower, isSigner: false, isWritable: true},
        {pubkey: a.binArrayUpper, isSigner: false, isWritable: true},
        {pubkey: a.tokenXProgram, isSigner: false, isWritable: false},
        {pubkey: a.tokenYProgram, isSigner: false, isWritable: false},
        {pubkey: eventAuthority, isSigner: false, isWritable: false},
        {pubkey: METEORA_DLMM_PROGRAM_ID, isSigner: false, isWritable: false},
    ];
}

/**
 * `add_liquidity(nonce, liquidity_parameter)` — `liquidityParameter` is the
 * raw borsh-serialized `LiquidityParameterByStrategy` from the Meteora IDL,
 * built client-side (e.g. via the @meteora-ag/dlmm SDK) and passed opaque.
 */
export function buildAddLiquidityIx(
    args: { nonce: Uint8Array; liquidityParameter: Buffer },
    accounts: ManageLiquidityAccounts
): TransactionInstruction {
    if (args.nonce.length !== 32) throw new Error('nonce must be 32 bytes');
    const data = Buffer.alloc(8 + 32 + 4 + args.liquidityParameter.length);
    anchorSighash('add_liquidity').copy(data, 0);
    Buffer.from(args.nonce).copy(data, 8);
    data.writeUInt32LE(args.liquidityParameter.length, 8 + 32);
    args.liquidityParameter.copy(data, 8 + 32 + 4);
    return new TransactionInstruction({
        programId: PRIVATE_WRAP_PROGRAM_ID,
        keys: manageLiquidityKeys(args.nonce, accounts),
        data,
    });
}

export function buildRemoveLiquidityIx(
    args: { nonce: Uint8Array; fromBinId: number; toBinId: number; bpsToRemove: number },
    accounts: ManageLiquidityAccounts
): TransactionInstruction {
    if (args.nonce.length !== 32) throw new Error('nonce must be 32 bytes');
    const data = Buffer.alloc(8 + 32 + 4 + 4 + 2);
    anchorSighash('remove_liquidity').copy(data, 0);
    Buffer.from(args.nonce).copy(data, 8);
    data.writeInt32LE(args.fromBinId, 8 + 32);
    data.writeInt32LE(args.toBinId, 8 + 32 + 4);
    data.writeUInt16LE(args.bpsToRemove, 8 + 32 + 8);
    return new TransactionInstruction({
        programId: PRIVATE_WRAP_PROGRAM_ID,
        keys: manageLiquidityKeys(args.nonce, accounts),
        data,
    });
}

export interface ClaimFeesAccounts {
    payer: PublicKey;
    position: PublicKey;
    lbPair: PublicKey;
    binArrayLower: PublicKey;
    binArrayUpper: PublicKey;
    reserveX: PublicKey;
    reserveY: PublicKey;
    /** Fresh token accounts — do not point at the leader's main wallet. */
    userTokenX: PublicKey;
    userTokenY: PublicKey;
    tokenXMint: PublicKey;
    tokenYMint: PublicKey;
    tokenProgram: PublicKey;
}

export function buildClaimFeesIx(
    args: { nonce: Uint8Array },
    a: ClaimFeesAccounts
): TransactionInstruction {
    if (args.nonce.length !== 32) throw new Error('nonce must be 32 bytes');
    const [positionOwner] = derivePositionOwner(args.nonce);
    const eventAuthority = deriveMeteoraEventAuthority();
    const data = Buffer.alloc(8 + 32);
    anchorSighash('claim_fees').copy(data, 0);
    Buffer.from(args.nonce).copy(data, 8);
    return new TransactionInstruction({
        programId: PRIVATE_WRAP_PROGRAM_ID,
        keys: [
            {pubkey: a.payer, isSigner: true, isWritable: true},
            {pubkey: positionOwner, isSigner: false, isWritable: false},
            {pubkey: a.lbPair, isSigner: false, isWritable: false},
            {pubkey: a.position, isSigner: false, isWritable: true},
            {pubkey: a.binArrayLower, isSigner: false, isWritable: true},
            {pubkey: a.binArrayUpper, isSigner: false, isWritable: true},
            {pubkey: a.reserveX, isSigner: false, isWritable: true},
            {pubkey: a.reserveY, isSigner: false, isWritable: true},
            {pubkey: a.userTokenX, isSigner: false, isWritable: true},
            {pubkey: a.userTokenY, isSigner: false, isWritable: true},
            {pubkey: a.tokenXMint, isSigner: false, isWritable: false},
            {pubkey: a.tokenYMint, isSigner: false, isWritable: false},
            {pubkey: a.tokenProgram, isSigner: false, isWritable: false},
            {pubkey: eventAuthority, isSigner: false, isWritable: false},
            {pubkey: METEORA_DLMM_PROGRAM_ID, isSigner: false, isWritable: false},
        ],
        data,
    });
}

export interface ClosePositionAccounts {
    payer: PublicKey;
    position: PublicKey;
    lbPair: PublicKey;
    binArrayLower: PublicKey;
    binArrayUpper: PublicKey;
    /** Fresh wallet — receives reclaimed rent. Don't use the leader's main wallet. */
    rentReceiver: PublicKey;
}

export function buildClosePositionIx(
    args: { nonce: Uint8Array },
    a: ClosePositionAccounts
): TransactionInstruction {
    if (args.nonce.length !== 32) throw new Error('nonce must be 32 bytes');
    const [positionOwner] = derivePositionOwner(args.nonce);
    const eventAuthority = deriveMeteoraEventAuthority();
    const data = Buffer.alloc(8 + 32);
    anchorSighash('close_position').copy(data, 0);
    Buffer.from(args.nonce).copy(data, 8);
    return new TransactionInstruction({
        programId: PRIVATE_WRAP_PROGRAM_ID,
        keys: [
            {pubkey: a.payer, isSigner: true, isWritable: true},
            {pubkey: positionOwner, isSigner: false, isWritable: false},
            {pubkey: a.position, isSigner: false, isWritable: true},
            {pubkey: a.lbPair, isSigner: false, isWritable: false},
            {pubkey: a.binArrayLower, isSigner: false, isWritable: true},
            {pubkey: a.binArrayUpper, isSigner: false, isWritable: true},
            {pubkey: a.rentReceiver, isSigner: false, isWritable: true},
            {pubkey: eventAuthority, isSigner: false, isWritable: false},
            {pubkey: METEORA_DLMM_PROGRAM_ID, isSigner: false, isWritable: false},
        ],
        data,
    });
}

// ----- Lookup -----

/**
 * Given a list of nonces, returns the DLMM Position pubkeys held under each
 * one's PDA. Used by the /private page to list a user's wrapped positions.
 */
export async function findPositionsForNonces(
    connection: Connection,
    nonces: Uint8Array[]
): Promise<Array<{ nonce: Uint8Array; owner: PublicKey; positions: PublicKey[] }>> {
    // The Meteora Position account stores `owner: Pubkey` at a fixed offset.
    // For the v2 layout that's offset 8 (anchor disc) + 32 (lb_pair) = 40.
    // Verify against your installed @meteora-ag/dlmm if the layout shifts.
    const OWNER_OFFSET = 40;

    const out: Array<{ nonce: Uint8Array; owner: PublicKey; positions: PublicKey[] }> = [];
    for (const nonce of nonces) {
        const [owner] = derivePositionOwner(nonce);
        const accounts = await connection.getProgramAccounts(METEORA_DLMM_PROGRAM_ID, {
            filters: [
                {memcmp: {offset: OWNER_OFFSET, bytes: owner.toBase58()}},
            ],
        });
        out.push({nonce, owner, positions: accounts.map(a => a.pubkey)});
    }
    return out;
}

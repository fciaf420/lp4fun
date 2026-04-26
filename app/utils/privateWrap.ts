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

import {Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction} from '@solana/web3.js';
import {sha256} from '@noble/hashes/sha2';
import bs58 from 'bs58';

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

/** The fixed message a user signs once to derive their master seed. */
export const NONCE_DERIVATION_MESSAGE =
    'lp4fun-private-v1: derive my private DLMM position keys';

/**
 * Derive a deterministic 32-byte nonce from a wallet signature + index.
 *
 * The wallet signs `NONCE_DERIVATION_MESSAGE` once. The resulting signature
 * acts as a master seed. Per-position nonces are `sha256(seed || index_le)`.
 *
 * Properties:
 *   - Unguessable to anyone who doesn't have the wallet (sig is unforgeable).
 *   - Recoverable: signing the same message yields the same seed yields the
 *     same nonces, so wiping localStorage doesn't lose access — the user
 *     just needs their wallet to recover their positions.
 *   - Unlinkable: from outside, the PDA looks random.
 */
export function deriveNonceFromSignature(
    signature: Uint8Array,
    index: number
): Uint8Array {
    const buf = Buffer.alloc(signature.length + 4);
    Buffer.from(signature).copy(buf, 0);
    buf.writeUInt32LE(index >>> 0, signature.length);
    return sha256(new Uint8Array(buf));
}

const EPHEMERAL_DOMAIN = new TextEncoder().encode('lp4fun-ephemeral-v1');

/**
 * Derive a deterministic ephemeral signing keypair from the unlock signature.
 * The connected wallet never signs any LP transaction — this keypair does.
 * Recoverable: signing the unlock message again gives the same keypair.
 *
 * Privacy property: the on-chain link from connected wallet to LP activity
 * is the funding tx (connected → ephemeral). That tx is broken cryptographically
 * by routing through PrivacyCash; see app/utils/privacyCash.ts.
 */
export function deriveEphemeralKeypair(masterSig: Uint8Array): Keypair {
    const buf = new Uint8Array(masterSig.length + EPHEMERAL_DOMAIN.length);
    buf.set(masterSig, 0);
    buf.set(EPHEMERAL_DOMAIN, masterSig.length);
    const seed = sha256(buf);
    return Keypair.fromSeed(seed.slice(0, 32));
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
    return Buffer.from(sha256(new TextEncoder().encode(`global:${name}`))).subarray(0, 8);
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

// ----- Direct Meteora ix builders (used outside the wrapper) -----

/**
 * Build Meteora's `initializeBinArray(index)` instruction. Anyone can call
 * this — bin arrays are pool-level state, not user-specific. We invoke it
 * directly (not through our wrapper) since the wrapper adds no privacy
 * benefit here: the ephemeral signs either way.
 *
 * Accounts (verified against @meteora-ag/dlmm 1.7.5 IDL):
 *   lbPair (ro), binArray (mut PDA), funder (mut, signer), systemProgram
 *
 * binArray PDA seeds: [b"bin_array", lbPair, i64 index little-endian]
 */
export function buildInitializeBinArrayIx(args: {
    funder: PublicKey;
    lbPair: PublicKey;
    binArray: PublicKey;
    /** Bin array index (signed 64-bit). Use SDK's binIdToBinArrayIndex. */
    index: bigint;
}): TransactionInstruction {
    // Meteora discriminator from IDL: [35, 86, 19, 185, 78, 212, 75, 211]
    const data = Buffer.alloc(8 + 8);
    Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]).copy(data, 0);
    data.writeBigInt64LE(args.index, 8);

    return new TransactionInstruction({
        programId: METEORA_DLMM_PROGRAM_ID,
        keys: [
            {pubkey: args.lbPair, isSigner: false, isWritable: false},
            {pubkey: args.binArray, isSigner: false, isWritable: true},
            {pubkey: args.funder, isSigner: true, isWritable: true},
            {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
        ],
        data,
    });
}

// ----- Strategy + LiquidityParameterByStrategy borsh helpers -----

/**
 * Meteora's StrategyType enum, in the exact on-chain order.
 * Verified against @meteora-ag/dlmm 1.7.5 IDL.
 */
export enum StrategyTypeOnChain {
    SpotOneSide = 0,
    CurveOneSide = 1,
    BidAskOneSide = 2,
    SpotBalanced = 3,
    CurveBalanced = 4,
    BidAskBalanced = 5,
    SpotImBalanced = 6,
    CurveImBalanced = 7,
    BidAskImBalanced = 8,
}

export interface StrategyParametersInput {
    minBinId: number;
    maxBinId: number;
    strategyType: StrategyTypeOnChain;
    /** Defaults to 64 zero bytes if not provided. */
    parameteres?: Uint8Array;
}

export interface LiquidityParameterByStrategyInput {
    amountX: bigint;
    amountY: bigint;
    activeId: number;
    maxActiveBinSlippage: number;
    strategy: StrategyParametersInput;
}

/**
 * Borsh-serialize a Meteora `LiquidityParameterByStrategy`. Layout:
 *   amountX: u64
 *   amountY: u64
 *   activeId: i32
 *   maxActiveBinSlippage: i32
 *   strategyParameters:
 *     minBinId: i32
 *     maxBinId: i32
 *     strategyType: u8 (enum tag)
 *     parameteres: [u8; 64]
 *
 * Total: 97 bytes.
 */
export function encodeLiquidityParameterByStrategy(
    p: LiquidityParameterByStrategyInput
): Buffer {
    const buf = Buffer.alloc(97);
    buf.writeBigUInt64LE(p.amountX, 0);
    buf.writeBigUInt64LE(p.amountY, 8);
    buf.writeInt32LE(p.activeId, 16);
    buf.writeInt32LE(p.maxActiveBinSlippage, 20);
    buf.writeInt32LE(p.strategy.minBinId, 24);
    buf.writeInt32LE(p.strategy.maxBinId, 28);
    buf.writeUInt8(p.strategy.strategyType, 32);
    const params = p.strategy.parameteres ?? new Uint8Array(64);
    if (params.length !== 64) {
        throw new Error('strategy.parameteres must be exactly 64 bytes');
    }
    Buffer.from(params).copy(buf, 33);
    return buf;
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
            {pubkey: a.lbPair, isSigner: false, isWritable: true},
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
            {pubkey: a.lbPair, isSigner: false, isWritable: true},
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

export interface FoundPosition {
    pubkey: PublicKey;
    lbPair: PublicKey;
}

/**
 * Given a list of nonces, returns the DLMM Position pubkeys held under each
 * one's PDA, along with each position's lbPair (parsed from the account
 * data).
 */
export async function findPositionsForNonces(
    connection: Connection,
    nonces: Uint8Array[]
): Promise<Array<{ nonce: Uint8Array; owner: PublicKey; positions: FoundPosition[] }>> {
    // PositionV2 layout (verified against @meteora-ag/dlmm 1.7.5):
    //   [0..8]   anchor discriminator [117,176,212,199,245,180,133,182]
    //   [8..40]  lb_pair (pubkey)
    //   [40..72] owner (pubkey)
    const POSITION_V2_DISCRIMINATOR = bs58.encode(
        Uint8Array.from([117, 176, 212, 199, 245, 180, 133, 182])
    );
    const OWNER_OFFSET = 40;

    const out: Array<{ nonce: Uint8Array; owner: PublicKey; positions: FoundPosition[] }> = [];
    for (const nonce of nonces) {
        const [owner] = derivePositionOwner(nonce);
        const accounts = await connection.getProgramAccounts(METEORA_DLMM_PROGRAM_ID, {
            filters: [
                {memcmp: {offset: 0, bytes: POSITION_V2_DISCRIMINATOR}},
                {memcmp: {offset: OWNER_OFFSET, bytes: owner.toBase58()}},
            ],
        });
        const positions: FoundPosition[] = accounts.map(a => ({
            pubkey: a.pubkey,
            lbPair: new PublicKey(a.account.data.subarray(8, 40)),
        }));
        out.push({nonce, owner, positions});
    }
    return out;
}

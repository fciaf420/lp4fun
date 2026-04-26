# dlmm-private-wrap

A scaffold of an Anchor program that holds Meteora DLMM positions under a
program-derived address (PDA) so that on-chain watchers can't trivially link
an LP to the wallet that funds them.

**Status:** scaffold. Not built, not deployed, not audited. Treat as a
starting point for the wrapper-program approach described in the
`claude/meteora-dlmm-private-lp-ZleZo` discussion.

## What it does

The Meteora DLMM `Position` account stores its `owner` as a plain `Pubkey`.
This wrapper passes a PDA of *this* program as that owner, so:

```
Tx signer:  (an ephemeral wallet you funded out of band)
Program:    dlmm-private-wrap
Inner CPI:  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo (Meteora DLMM)
Position.owner:  PDA(seeds = [b"pos", nonce])
```

A copy-trader bot subscribed to `LeAd…` (the leader's known wallet) sees
nothing. To copy, the bot would have to:

1. Know about this program (easy — it's on-chain).
2. Decode the `init_position` / `add_liquidity` instructions.
3. **Tie the ephemeral signer back to the leader.** This is the only attack
   surface that matters and is what the rest of the stack (Umbra-funded
   ephemeral wallets, Jito bundles) is for.

## What it does *not* hide

- The DLMM position itself. Bin range, amounts, fees — all still public.
  This wrapper hides **attribution**, not state.
- Tx signer pubkey. The `payer` and `sender` of each top-level tx are
  visible. Use a fresh keypair per session; fund it from a CEX or via
  Umbra shielded transfer.
- Withdrawal destinations. `claim_fees` and `close_position` route tokens
  and rent to whatever accounts you pass — point them at fresh accounts,
  not the leader's main wallet. Otherwise the link is restored.

## Privacy = anonymity set

A wrapper with one user offers no privacy. Watchers will simply equate "any
tx to this program" with "the one user". Privacy improves with N. Two
realistic shapes:

1. **Public wrapper, many users.** Open-source the program; anyone can use
   it. Watchers see a stream of opaque PDA-owned positions and can't tell
   whose is whose. No fee capture unless you tip-tax.
2. **Private aggregating vault.** Several users deposit into one shared
   DLMM position; the program tracks per-user shares internally. Stronger
   privacy, but you become a fund manager (custody and regulatory risk).

This scaffold targets shape #1.

## Layout

```
programs/dlmm-private-wrap/
├── Cargo.toml
├── Xargo.toml
└── src/lib.rs
```

Five instructions, each forwarded as a CPI to Meteora DLMM with the
position-owner PDA signing:

| ix              | DLMM ix called                | Notes |
|-----------------|-------------------------------|-------|
| `init_position` | `initialize_position`         | Caller passes a fresh `Position` keypair. |
| `add_liquidity` | `add_liquidity_by_strategy`   | `liquidity_parameter` is the borsh-serialized strategy struct from the IDL, passed opaque. |
| `remove_liquidity` | `remove_liquidity_by_range` | Args: `from_bin_id`, `to_bin_id`, `bps_to_remove`. |
| `claim_fees`    | `claim_fee`                   | Fees go to `user_token_x` / `user_token_y` — pass fresh accounts. |
| `close_position`| `close_position`              | Rent goes to `rent_receiver` — pass a fresh account. |

The PDA seeds are `[b"pos", nonce]` where `nonce` is 32 bytes the caller
generates and stores off-chain. **Anyone who knows the nonce controls the
position.** Treat it like a key.

## Choosing the nonce

- ❌ `nonce = hash(leader.pubkey || index)` → trivially enumerable, defeats
  the purpose.
- ❌ `nonce = sequential counter` → small search space.
- ✅ `nonce = 32 random bytes from a CSPRNG`, stored encrypted client-side.

## Recommended end-to-end flow

```
Leader's main wallet
        │  (Umbra shielded transfer, or CEX hop)
        ▼
Ephemeral wallet (fresh keypair, used once)
        │  (sign + Jito bundle)
        ▼
dlmm-private-wrap.init_position(nonce, …)
        │  (CPI, signs as PDA(b"pos", nonce))
        ▼
Meteora DLMM Position (owner = PDA(b"pos", nonce))
```

When closing or claiming, withdraw to a fresh wallet — **never** route
tokens straight back to the leader's main wallet, or the entire chain
de-anonymizes retroactively.

## Caveats

- **Smart-contract risk.** A bug in this program drains every user's
  position. Audit before any TVL.
- **No Anchor crate exists for `lb_clmm`.** This program builds the inner
  instruction data manually using anchor sighashes (`global:initialize_position`
  etc.) and the account ordering from Meteora's published IDL. If Meteora
  changes that IDL, this program needs to be updated.
- **`bin_array_bitmap_extension`** is optional in Meteora's interface; when
  not in use, pass the Meteora program id as a placeholder (per Meteora's
  SDK convention). This scaffold treats it as `UncheckedAccount`.
- **`event_authority`** must be the Meteora-derived event-authority PDA, not
  one of yours. Compute client-side.
- **`lp4fun` indexing.** The lp4fun frontend currently looks up positions
  by wallet `owner`. To list positions held by this wrapper for a given
  user, the frontend will need a separate lookup keyed by the user's stored
  nonces.

## Once Arcium / CSPL matures

The cleaner long-term answer is custodying the DLMM position inside an
Arcium MPC program with confidential state, so even the position record
itself is encrypted. As of April 2026, no such integration exists, and
Arcium Mainnet Alpha access is gated. Until then, this PDA wrapper is the
practical move.

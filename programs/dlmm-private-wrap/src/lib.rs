//! dlmm-private-wrap
//!
//! A thin custodial wrapper around the Meteora DLMM program (`lb_clmm`,
//! program id `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`).
//!
//! The DLMM `Position` account stores its `owner` as a plain `Pubkey`. By
//! making that `owner` a PDA of this program, on-chain watchers cannot link
//! the position back to a known leader wallet — the position's owner is just
//! "some PDA of this program", and the only thing tying a user to it is the
//! `nonce` they chose, which lives off-chain.
//!
//! Anonymity set is the whole game: privacy improves with the number of
//! distinct users invoking this program. A wrapper with a single user offers
//! no privacy. See README.md for the full threat model.
//!
//! NOTE: This is a scaffold. The CPI account ordering matches the Meteora
//! DLMM IDL (instruction account lists) but the inner instruction data is
//! built manually using anchor sighashes — there is no published Anchor crate
//! for `lb_clmm`. Audit and integration-test before any real funds.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed};

declare_id!("11111111111111111111111111111111");

/// Meteora DLMM program id (`lb_clmm`).
pub mod meteora {
    use anchor_lang::prelude::*;
    declare_id!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
}

/// Seed prefix for position-owner PDAs.
pub const POSITION_OWNER_SEED: &[u8] = b"pos";

#[program]
pub mod dlmm_private_wrap {
    use super::*;

    /// Initialize a DLMM position whose owner is a PDA of this program.
    ///
    /// `nonce` is supplied by the caller and should be 32 random bytes that
    /// the caller stores off-chain. Anyone who knows the nonce can manage
    /// the position; treat it like a key.
    pub fn init_position(
        ctx: Context<InitPosition>,
        nonce: [u8; 32],
        lower_bin_id: i32,
        width: i32,
    ) -> Result<()> {
        let bump = ctx.bumps.position_owner;
        let signer_seeds: &[&[&[u8]]] = &[&[POSITION_OWNER_SEED, &nonce, &[bump]]];

        // initialize_position(lower_bin_id: i32, width: i32)
        // accounts: payer, position, lb_pair, owner, system_program, rent,
        //           event_authority, program
        let mut data = sighash("global", "initialize_position").to_vec();
        data.extend_from_slice(&lower_bin_id.to_le_bytes());
        data.extend_from_slice(&width.to_le_bytes());

        let ix = Instruction {
            program_id: meteora::ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.payer.key(), true),
                AccountMeta::new(ctx.accounts.position.key(), true),
                AccountMeta::new_readonly(ctx.accounts.lb_pair.key(), false),
                AccountMeta::new_readonly(ctx.accounts.position_owner.key(), true),
                AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(meteora::ID, false),
            ],
            data,
        };

        invoke_signed(
            &ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.position_owner.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
                ctx.accounts.rent.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.meteora_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        Ok(())
    }

    /// Add liquidity to a position owned by this program's PDA.
    ///
    /// `liquidity_parameter` is the raw, borsh-serialized
    /// `LiquidityParameterByStrategy` struct from the Meteora IDL — built
    /// client-side and passed through opaque so this program doesn't need
    /// to mirror Meteora's strategy enum.
    pub fn add_liquidity(
        ctx: Context<ManageLiquidity>,
        nonce: [u8; 32],
        liquidity_parameter: Vec<u8>,
    ) -> Result<()> {
        let bump = ctx.bumps.position_owner;
        let signer_seeds: &[&[&[u8]]] = &[&[POSITION_OWNER_SEED, &nonce, &[bump]]];

        let mut data = sighash("global", "add_liquidity_by_strategy").to_vec();
        data.extend_from_slice(&liquidity_parameter);

        let ix = Instruction {
            program_id: meteora::ID,
            accounts: meteora_liquidity_accounts(
                &ctx.accounts.position.key(),
                &ctx.accounts.lb_pair.key(),
                &ctx.accounts.bin_array_bitmap_extension,
                &ctx.accounts.user_token_x.key(),
                &ctx.accounts.user_token_y.key(),
                &ctx.accounts.reserve_x.key(),
                &ctx.accounts.reserve_y.key(),
                &ctx.accounts.token_x_mint.key(),
                &ctx.accounts.token_y_mint.key(),
                &ctx.accounts.bin_array_lower.key(),
                &ctx.accounts.bin_array_upper.key(),
                &ctx.accounts.position_owner.key(),
                &ctx.accounts.token_x_program.key(),
                &ctx.accounts.token_y_program.key(),
                &ctx.accounts.event_authority.key(),
            ),
            data,
        };

        invoke_signed(&ix, &liquidity_account_infos(&ctx), signer_seeds)?;
        Ok(())
    }

    /// Remove liquidity over a bin range.
    pub fn remove_liquidity(
        ctx: Context<ManageLiquidity>,
        nonce: [u8; 32],
        from_bin_id: i32,
        to_bin_id: i32,
        bps_to_remove: u16,
    ) -> Result<()> {
        let bump = ctx.bumps.position_owner;
        let signer_seeds: &[&[&[u8]]] = &[&[POSITION_OWNER_SEED, &nonce, &[bump]]];

        let mut data = sighash("global", "remove_liquidity_by_range").to_vec();
        data.extend_from_slice(&from_bin_id.to_le_bytes());
        data.extend_from_slice(&to_bin_id.to_le_bytes());
        data.extend_from_slice(&bps_to_remove.to_le_bytes());

        let ix = Instruction {
            program_id: meteora::ID,
            accounts: meteora_liquidity_accounts(
                &ctx.accounts.position.key(),
                &ctx.accounts.lb_pair.key(),
                &ctx.accounts.bin_array_bitmap_extension,
                &ctx.accounts.user_token_x.key(),
                &ctx.accounts.user_token_y.key(),
                &ctx.accounts.reserve_x.key(),
                &ctx.accounts.reserve_y.key(),
                &ctx.accounts.token_x_mint.key(),
                &ctx.accounts.token_y_mint.key(),
                &ctx.accounts.bin_array_lower.key(),
                &ctx.accounts.bin_array_upper.key(),
                &ctx.accounts.position_owner.key(),
                &ctx.accounts.token_x_program.key(),
                &ctx.accounts.token_y_program.key(),
                &ctx.accounts.event_authority.key(),
            ),
            data,
        };

        invoke_signed(&ix, &liquidity_account_infos(&ctx), signer_seeds)?;
        Ok(())
    }

    /// Claim accrued fees. Fees flow to the token accounts passed in
    /// (`user_token_x` / `user_token_y`) — point these at fresh accounts
    /// you control, not the leader's main wallet.
    pub fn claim_fees(ctx: Context<ClaimFees>, nonce: [u8; 32]) -> Result<()> {
        let bump = ctx.bumps.position_owner;
        let signer_seeds: &[&[&[u8]]] = &[&[POSITION_OWNER_SEED, &nonce, &[bump]]];

        let data = sighash("global", "claim_fee").to_vec();

        let ix = Instruction {
            program_id: meteora::ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.lb_pair.key(), false),
                AccountMeta::new(ctx.accounts.position.key(), false),
                AccountMeta::new(ctx.accounts.bin_array_lower.key(), false),
                AccountMeta::new(ctx.accounts.bin_array_upper.key(), false),
                AccountMeta::new_readonly(ctx.accounts.position_owner.key(), true),
                AccountMeta::new(ctx.accounts.reserve_x.key(), false),
                AccountMeta::new(ctx.accounts.reserve_y.key(), false),
                AccountMeta::new(ctx.accounts.user_token_x.key(), false),
                AccountMeta::new(ctx.accounts.user_token_y.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_x_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_y_mint.key(), false),
                AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(meteora::ID, false),
            ],
            data,
        };

        invoke_signed(
            &ix,
            &[
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.position.to_account_info(),
                ctx.accounts.bin_array_lower.to_account_info(),
                ctx.accounts.bin_array_upper.to_account_info(),
                ctx.accounts.position_owner.to_account_info(),
                ctx.accounts.reserve_x.to_account_info(),
                ctx.accounts.reserve_y.to_account_info(),
                ctx.accounts.user_token_x.to_account_info(),
                ctx.accounts.user_token_y.to_account_info(),
                ctx.accounts.token_x_mint.to_account_info(),
                ctx.accounts.token_y_mint.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.meteora_program.to_account_info(),
            ],
            signer_seeds,
        )?;
        Ok(())
    }

    /// Close the position. Rent flows to `rent_receiver` — again, a fresh
    /// account, not the leader's main wallet.
    pub fn close_position(ctx: Context<ClosePosition>, nonce: [u8; 32]) -> Result<()> {
        let bump = ctx.bumps.position_owner;
        let signer_seeds: &[&[&[u8]]] = &[&[POSITION_OWNER_SEED, &nonce, &[bump]]];

        let data = sighash("global", "close_position").to_vec();

        let ix = Instruction {
            program_id: meteora::ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.position.key(), false),
                AccountMeta::new(ctx.accounts.lb_pair.key(), false),
                AccountMeta::new(ctx.accounts.bin_array_lower.key(), false),
                AccountMeta::new(ctx.accounts.bin_array_upper.key(), false),
                AccountMeta::new_readonly(ctx.accounts.position_owner.key(), true),
                AccountMeta::new(ctx.accounts.rent_receiver.key(), false),
                AccountMeta::new_readonly(ctx.accounts.event_authority.key(), false),
                AccountMeta::new_readonly(meteora::ID, false),
            ],
            data,
        };

        invoke_signed(
            &ix,
            &[
                ctx.accounts.position.to_account_info(),
                ctx.accounts.lb_pair.to_account_info(),
                ctx.accounts.bin_array_lower.to_account_info(),
                ctx.accounts.bin_array_upper.to_account_info(),
                ctx.accounts.position_owner.to_account_info(),
                ctx.accounts.rent_receiver.to_account_info(),
                ctx.accounts.event_authority.to_account_info(),
                ctx.accounts.meteora_program.to_account_info(),
            ],
            signer_seeds,
        )?;
        Ok(())
    }
}

// ---------- Account contexts ----------

#[derive(Accounts)]
#[instruction(nonce: [u8; 32])]
pub struct InitPosition<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The DLMM Position account being created. Caller passes a fresh keypair
    /// (or a derived address); Meteora's `initialize_position` initializes it.
    /// CHECK: validated by the inner Meteora CPI.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: Meteora `LbPair` account. Validated by inner CPI.
    pub lb_pair: UncheckedAccount<'info>,

    /// PDA that becomes the position's `owner`. Derived from the nonce so it
    /// is unlinkable to the caller.
    /// CHECK: PDA, no data of our own.
    #[account(seeds = [POSITION_OWNER_SEED, &nonce], bump)]
    pub position_owner: UncheckedAccount<'info>,

    /// CHECK: Meteora event authority PDA.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = meteora::ID)]
    pub meteora_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(nonce: [u8; 32])]
pub struct ManageLiquidity<'info> {
    /// CHECK: validated by inner CPI.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: validated by inner CPI.
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: optional bitmap extension; pass program id when not used.
    #[account(mut)]
    pub bin_array_bitmap_extension: UncheckedAccount<'info>,
    /// CHECK: token account.
    #[account(mut)]
    pub user_token_x: UncheckedAccount<'info>,
    /// CHECK: token account.
    #[account(mut)]
    pub user_token_y: UncheckedAccount<'info>,
    /// CHECK: pool reserve.
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: pool reserve.
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    /// CHECK: mint.
    pub token_x_mint: UncheckedAccount<'info>,
    /// CHECK: mint.
    pub token_y_mint: UncheckedAccount<'info>,
    /// CHECK: bin array.
    #[account(mut)]
    pub bin_array_lower: UncheckedAccount<'info>,
    /// CHECK: bin array.
    #[account(mut)]
    pub bin_array_upper: UncheckedAccount<'info>,

    #[account(seeds = [POSITION_OWNER_SEED, &nonce], bump)]
    /// CHECK: PDA signer.
    pub position_owner: UncheckedAccount<'info>,

    /// CHECK: SPL Token or Token-2022 program.
    pub token_x_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token or Token-2022 program.
    pub token_y_program: UncheckedAccount<'info>,
    /// CHECK: event authority.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = meteora::ID)]
    pub meteora_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(nonce: [u8; 32])]
pub struct ClaimFees<'info> {
    /// CHECK: validated by inner CPI.
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: validated by inner CPI.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: bin array.
    #[account(mut)]
    pub bin_array_lower: UncheckedAccount<'info>,
    /// CHECK: bin array.
    #[account(mut)]
    pub bin_array_upper: UncheckedAccount<'info>,

    #[account(seeds = [POSITION_OWNER_SEED, &nonce], bump)]
    /// CHECK: PDA signer.
    pub position_owner: UncheckedAccount<'info>,

    /// CHECK: pool reserve.
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: pool reserve.
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    /// CHECK: destination token account — pass a fresh account.
    #[account(mut)]
    pub user_token_x: UncheckedAccount<'info>,
    /// CHECK: destination token account — pass a fresh account.
    #[account(mut)]
    pub user_token_y: UncheckedAccount<'info>,
    /// CHECK: mint.
    pub token_x_mint: UncheckedAccount<'info>,
    /// CHECK: mint.
    pub token_y_mint: UncheckedAccount<'info>,
    /// CHECK: SPL Token program.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: event authority.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = meteora::ID)]
    pub meteora_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(nonce: [u8; 32])]
pub struct ClosePosition<'info> {
    /// CHECK: validated by inner CPI.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: validated by inner CPI.
    #[account(mut)]
    pub lb_pair: UncheckedAccount<'info>,
    /// CHECK: bin array.
    #[account(mut)]
    pub bin_array_lower: UncheckedAccount<'info>,
    /// CHECK: bin array.
    #[account(mut)]
    pub bin_array_upper: UncheckedAccount<'info>,

    #[account(seeds = [POSITION_OWNER_SEED, &nonce], bump)]
    /// CHECK: PDA signer.
    pub position_owner: UncheckedAccount<'info>,

    /// CHECK: rent destination — pass a fresh account, not the leader's wallet.
    #[account(mut)]
    pub rent_receiver: UncheckedAccount<'info>,

    /// CHECK: event authority.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: address-checked.
    #[account(address = meteora::ID)]
    pub meteora_program: UncheckedAccount<'info>,
}

// ---------- Helpers ----------

/// Anchor-style 8-byte sighash for `namespace:name`. Used because there is no
/// published Anchor crate for `lb_clmm` we can `cpi::` into directly.
fn sighash(namespace: &str, name: &str) -> [u8; 8] {
    let preimage = format!("{}:{}", namespace, name);
    let hash = anchor_lang::solana_program::hash::hash(preimage.as_bytes());
    let mut out = [0u8; 8];
    out.copy_from_slice(&hash.to_bytes()[..8]);
    out
}

#[allow(clippy::too_many_arguments)]
fn meteora_liquidity_accounts(
    position: &Pubkey,
    lb_pair: &Pubkey,
    bin_array_bitmap_extension: &UncheckedAccount,
    user_token_x: &Pubkey,
    user_token_y: &Pubkey,
    reserve_x: &Pubkey,
    reserve_y: &Pubkey,
    token_x_mint: &Pubkey,
    token_y_mint: &Pubkey,
    bin_array_lower: &Pubkey,
    bin_array_upper: &Pubkey,
    sender: &Pubkey,
    token_x_program: &Pubkey,
    token_y_program: &Pubkey,
    event_authority: &Pubkey,
) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(*position, false),
        AccountMeta::new(*lb_pair, false),
        AccountMeta::new(bin_array_bitmap_extension.key(), false),
        AccountMeta::new(*user_token_x, false),
        AccountMeta::new(*user_token_y, false),
        AccountMeta::new(*reserve_x, false),
        AccountMeta::new(*reserve_y, false),
        AccountMeta::new_readonly(*token_x_mint, false),
        AccountMeta::new_readonly(*token_y_mint, false),
        AccountMeta::new(*bin_array_lower, false),
        AccountMeta::new(*bin_array_upper, false),
        AccountMeta::new_readonly(*sender, true),
        AccountMeta::new_readonly(*token_x_program, false),
        AccountMeta::new_readonly(*token_y_program, false),
        AccountMeta::new_readonly(*event_authority, false),
        AccountMeta::new_readonly(meteora::ID, false),
    ]
}

fn liquidity_account_infos<'info>(ctx: &Context<ManageLiquidity<'info>>) -> Vec<AccountInfo<'info>> {
    vec![
        ctx.accounts.position.to_account_info(),
        ctx.accounts.lb_pair.to_account_info(),
        ctx.accounts.bin_array_bitmap_extension.to_account_info(),
        ctx.accounts.user_token_x.to_account_info(),
        ctx.accounts.user_token_y.to_account_info(),
        ctx.accounts.reserve_x.to_account_info(),
        ctx.accounts.reserve_y.to_account_info(),
        ctx.accounts.token_x_mint.to_account_info(),
        ctx.accounts.token_y_mint.to_account_info(),
        ctx.accounts.bin_array_lower.to_account_info(),
        ctx.accounts.bin_array_upper.to_account_info(),
        ctx.accounts.position_owner.to_account_info(),
        ctx.accounts.token_x_program.to_account_info(),
        ctx.accounts.token_y_program.to_account_info(),
        ctx.accounts.event_authority.to_account_info(),
        ctx.accounts.meteora_program.to_account_info(),
    ]
}

use crate::errors::MarketError;
use crate::math;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [MARKET_SEED, market.authority.as_ref(), &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        close = owner,                       // rent reclaim + structural double-claim block
        has_one = owner,
        has_one = market,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref(), &[position.bucket_index]],
        bump = position.bump
    )]
    pub position: Account<'info, Position>,
    /// CHECK: system-owned vault PDA, validated by seeds
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Claim>) -> Result<()> {
    let m = &ctx.accounts.market;
    let p = &ctx.accounts.position;
    require!(m.state == MarketState::Resolved, MarketError::MarketNotResolved);

    let outcome = m.outcome.ok_or(MarketError::MarketNotResolved)?;
    let sum_weights = m.sum_weights.ok_or(MarketError::MarketNotResolved)?;

    // recompute this bucket's weight deterministically from stored outcome
    let mid = math::midpoint(m.bucket_start, m.bucket_width, p.bucket_index)?;
    let x = math::clamp_outcome(outcome, m.bucket_start, m.bucket_width, m.num_buckets);
    let w = math::weight(mid.abs_diff(x), m.bucket_width);

    let amount = math::payout(
        p.amount,
        m.bucket_totals[p.bucket_index as usize],
        w,
        sum_weights,
        m.total_pool,
    )?;

    let market_key = m.key();
    let seeds: &[&[u8]] = &[VAULT_SEED, market_key.as_ref(), &[m.vault_bump]];
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.key(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.owner.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    Ok(())
}
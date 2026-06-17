use anchor_lang::prelude::*;
use crate::errors::MarketError;
use crate::state::*;
use anchor_lang::system_program::{transfer, Transfer};

#[derive(Accounts)]
#[instruction(bucket_index: u8)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,

    #[account(
        mut,
        seeds = [MARKET_SEED, market.authority.as_ref(),
    &market.market_id.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(
        init_if_needed,
        payer = bettor,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, market.key().as_ref(), bettor.key().as_ref(), &[bucket_index]],
        bump
    )]
    pub position: Account<'info, Position>,

    /// CHECK: system-owned vault PDA, validated by seeds
    #[account(
        mut,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<PlaceBet>, bucket_index: u8, amount: u64) -> Result<()> {
    let m = &mut ctx.accounts.market;
    let now = Clock::get()?.unix_timestamp;

    require!(m.state == MarketState::Open, MarketError::MarketNotOpen);
    require!(now >= m.betting_open && now < m.betting_close, MarketError::BettingWindowClosed);
    require!(amount >= m.min_bet, MarketError::BetTooSmall);
    require!(bucket_index < m.num_buckets, MarketError::InvalidBucket);

    transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.bettor.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        amount,
    )?;

    let p = &mut ctx.accounts.position;
    if p.amount == 0 {
        p.market = m.key();
        p.owner = ctx.accounts.bettor.key();
        p.bucket_index = bucket_index;
        p.bump = ctx.bumps.position;
    }
    p.amount = p.amount.checked_add(amount).ok_or(MarketError::Overflow)?;

    m.bucket_totals[bucket_index as usize] = m.bucket_totals[bucket_index as usize]
        .checked_add(amount).ok_or(MarketError::Overflow)?;
    m.total_pool = m.total_pool.checked_add(amount).ok_or(MarketError::Overflow)?;
    Ok(())
}
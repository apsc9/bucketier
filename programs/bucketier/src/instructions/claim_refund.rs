use crate::errors::MarketError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [MARKET_SEED, market.authority.as_ref(), &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        close = owner,
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

pub fn handler(ctx: Context<ClaimRefund>) -> Result<()> {
    let m = &ctx.accounts.market;
    require!(m.state == MarketState::Canceled, MarketError::MarketNotCanceled);

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
        ctx.accounts.position.amount,
    )?;
    Ok(())
}
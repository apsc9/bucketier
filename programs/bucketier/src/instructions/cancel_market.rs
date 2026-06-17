use crate::errors::MarketError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CancelMarket<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [MARKET_SEED, market.authority.as_ref(), &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
}

pub fn handler(ctx: Context<CancelMarket>) -> Result<()> {
    let m = &mut ctx.accounts.market;
    let now = Clock::get()?.unix_timestamp;
    require!(m.state == MarketState::Open, MarketError::MarketNotOpen);

    let authority_cleanup = ctx.accounts.caller.key() == m.authority && m.total_pool == 0;
    let oracle_failure_void = now > m.resolve_deadline; // permissionless backstop
    require!(authority_cleanup || oracle_failure_void, MarketError::CancelNotAllowed);

    m.state = MarketState::Canceled;
    Ok(())
}
use crate::errors::MarketError;
use crate::math;
use crate::pyth;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    pub caller: Signer<'info>,
    #[account(
        mut,
        seeds = [MARKET_SEED, market.authority.as_ref(), &market.market_id.to_le_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    /// CHECK: owner validated as Pyth receiver program; data manually deserialized.
    /// A forged look-alike account fails the owner check.
    #[account(owner = pyth::PYTH_RECEIVER_ID @ MarketError::WrongOracleFeed)]
    pub price_update: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<ResolveMarket>) -> Result<()> {
    let m = &mut ctx.accounts.market;
    let now = Clock::get()?.unix_timestamp;
    require!(m.state == MarketState::Open, MarketError::MarketNotOpen);
    require!(now >= m.resolution_time, MarketError::TooEarlyToResolve);
    require!(m.total_pool > 0, MarketError::EmptyMarket);

    let data = ctx.accounts.price_update.try_borrow_data()?;
    let price_update = pyth::PriceUpdateV2::try_deserialize(&data)?;
    let pm = &price_update.price_message;

    require!(pm.feed_id == m.feed_id, MarketError::WrongOracleFeed);
    require!(
        (pm.publish_time - m.resolution_time).abs() <= RESOLVE_TOLERANCE,
        MarketError::BadResolutionTimestamp
    );
    require!(pm.price > 0, MarketError::InvalidOraclePrice);
    // conf/price ≤ 2%  ⇔  conf · 50 ≤ price (integer math, generous for live demo)
    require!(
        (pm.conf as u128) * 50 <= (pm.price as u128),
        MarketError::ConfidenceTooWide
    );

    let outcome = math::scale_price(pm.price, pm.exponent, m.bucket_decimals)?;
    let (_, sum) = math::compute_weights(
        outcome, m.bucket_start, m.bucket_width, m.num_buckets, &m.bucket_totals,
    )?;

    m.outcome = Some(outcome);
    m.sum_weights = Some(sum);
    m.state = MarketState::Resolved;
    Ok(())
}
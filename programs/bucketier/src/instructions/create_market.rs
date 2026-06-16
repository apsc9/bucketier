use crate::errors::MarketError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateMarketArgs {
    pub market_id: u64,
    pub feed_id: [u8; 32],
    pub bucket_decimals: u8,
    pub bucket_start: u64,
    pub bucket_width: u64,
    pub num_buckets: u8,
    pub min_bet: u64,
    pub betting_open: i64,
    pub betting_close: i64,
    pub resolution_time: i64,
    pub resolve_deadline: i64,
}

#[derive(Accounts)]
#[instruction(args: CreateMarketArgs)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Market::INIT_SPACE,
        seeds = [MARKET_SEED, authority.key().as_ref(), &args.market_id.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, Market>,
    /// CHECK: system-owned vault PDA, only holds lamports; validated by seeds
    #[account(
        mut, 
        seeds = [VAULT_SEED, market.key().as_ref()], 
        bump
    )]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
    require!(
        args.num_buckets >= 2 && args.num_buckets as usize <= MAX_BUCKETS
            && args.bucket_width > 0 && args.min_bet > 0,
        MarketError::InvalidParams
    );
    // range must not overflow u64
    args.bucket_start
        .checked_add((args.num_buckets as u64).checked_mul(args.bucket_width).ok_or(MarketError::InvalidParams)?)
        .ok_or(MarketError::InvalidParams)?;
    require!(
        args.betting_open < args.betting_close
            && args.betting_close <= args.resolution_time
            && args.resolution_time < args.resolve_deadline,
        MarketError::InvalidTimeStamps
    );

    // fund vault to rent-exempt minimum so the system account persists (spec §4)
    let rent_floor = Rent::get()?.minimum_balance(0);
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        rent_floor,
    )?;

    let m = &mut ctx.accounts.market;
    m.authority = ctx.accounts.authority.key();
    m.market_id = args.market_id;
    m.feed_id = args.feed_id;
    m.bucket_decimals = args.bucket_decimals;
    m.bucket_start = args.bucket_start;
    m.bucket_width = args.bucket_width;
    m.num_buckets = args.num_buckets;
    m.min_bet = args.min_bet;
    m.total_pool = 0;
    m.bucket_totals = [0; MAX_BUCKETS];
    m.betting_open = args.betting_open;
    m.betting_close = args.betting_close;
    m.resolution_time = args.resolution_time;
    m.resolve_deadline = args.resolve_deadline;
    m.state = MarketState::Open;
    m.outcome = None;
    m.sum_weights = None;
    m.bump = ctx.bumps.market;
    m.vault_bump = ctx.bumps.vault;
    Ok(())
}
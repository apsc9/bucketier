use anchor_lang::prelude::*;

pub mod pyth;
pub mod errors;
pub mod state;
pub mod math;
pub mod instructions;

pub use instructions::*;

declare_id!("3YPmf5odBQdY3dbNWeTVk96EkGKumwvQnwGed4x8DrGA");

#[program]
pub mod bucketier {
    use super::*;

    pub fn create_market(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
        instructions::create_market::handler(ctx, args)
    }

    pub fn place_bet(ctx: Context<PlaceBet>, bucket_index: u8, amount: u64) -> Result<()> {
        instructions::place_bet::handler(ctx, bucket_index, amount)
    }

    pub fn cancel_market(ctx: Context<CancelMarket>) -> Result<()> {
        instructions::cancel_market::handler(ctx)
    }
    
    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        instructions::claim_refund::handler(ctx)
    }

    pub fn resolve_market(ctx: Context<ResolveMarket>) -> Result<()> {
        instructions::resolve_market::handler(ctx)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handler(ctx)
    }
}

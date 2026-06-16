use anchor_lang::prelude::*;

pub mod pyth;
pub mod errors;
pub mod state;
pub mod math;
pub mod instructions;

pub use instructions::*;

declare_id!("9FJcX3zua4QdtxtBpKeHUy4JvxBHpEbqbHLKdp9Y4ya3");

#[program]
pub mod bucketier {
    use super::*;

    pub fn create_market(ctx: Context<CreateMarket>, args: CreateMarketArgs) -> Result<()> {
        instructions::create_market::handler(ctx, args)
    }
}

use anchor_lang::prelude::*;

pub mod pyth;
pub mod errors;
pub mod state;
pub mod math;

declare_id!("9FJcX3zua4QdtxtBpKeHUy4JvxBHpEbqbHLKdp9Y4ya3");

#[program]
pub mod bucketier {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}

use anchor_lang::prelude::*;

pub const MAX_BUCKETS: usize = 10;
pub const SCALE: u128 = 1_000_000_000; 
pub const RESOLVE_TOLERANCE: i64 = 60; // seconds around resolution time
pub const MARKET_SEED: &[u8] = b"market";
pub const POSITION_SEED: &[u8] = b"position";
pub const VAULT_SEED: &[u8] = b"vault";

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum MarketState {
    Open,
    Resolved,
    Canceled,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub authority: Pubkey,
    pub market_id: u64,
    pub feed_id: [u8; 32],    // Pyth Hermes feed id, not an account Pubkey
    pub bucket_decimals: u8,  // bucket params are USD* 10^ bucket_decimals
    pub bucket_start: u64,
    pub bucket_width: u64,
    pub num_buckets: u8,      // could be between 2 - 10
    pub min_bet: u64,         // lamports
    pub total_pool: u64,      // lamports, excludes vault rent floor
    pub bucket_totals: [u64; MAX_BUCKETS],
    pub betting_open: i64,    // unix timestamp
    pub betting_close: i64,
    pub resolution_time: i64,
    pub resolve_deadline: i64,
    pub state: MarketState,
    pub outcome: Option<u64>,   // resolved price, bucket_decimals units 
    pub sum_weights: Option<u64>, // over funded buckets only
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub bucket_index: u8,
    pub amount: u64,
    pub bump: u8,
}
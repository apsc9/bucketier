use anchor_lang::prelude::*;

#[error_code]
pub enum MarketError {
    #[msg("market is not open")]
    MarketNotOpen,
    #[msg("market is not resolved")]
    MarketNotResolved,
    #[msg("market is not cancelled")]
    MarketNotCanceled,
    #[msg("Invalid market parameters")]
    InvalidParams,
    #[msg("timestamps must be ordered")]
    InvalidTimeStamps,
    #[msg("betting window closed")]
    BettingWindowClosed,
    #[msg("bet below minimun")]
    BetTooSmall,
    #[msg("bucket index out of range")]
    InvalidBucket,
    #[msg("too early to resolve")]
    TooEarlyToResolve,
    #[msg("market has no bets")]
    EmptyMarket,
    #[msg("oracle feed mismatch")]
    WrongOracleFeed,
    #[msg("publish_time outside tolerance")]
    BadResolutionTimestamp,
    #[msg("oracle price not positive")]
    InvalidOraclePrice,
    #[msg("oracle confidence too wide")]
    ConfidenceTooWide,
    #[msg("oracle exponent out of range")]
    BadExponent,
    #[msg("cancel conditions not met")]
    CancelNotAllowed,
    #[msg("arithmetic overflow")]
    Overflow,
}
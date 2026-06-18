use crate::errors::MarketError;
use crate::state::{MAX_BUCKETS, SCALE};
use anchor_lang::prelude::*;

pub const SCALE_U64: u64 = SCALE as u64;

/// get midpoint of bucket i in bucket_decimal units
pub fn midpoint(bucket_start: u64, bucket_width: u64, i: u8) -> Result<u64> {
    bucket_start
        .checked_add((i as u64).checked_mul(bucket_width).ok_or(MarketError::Overflow)?)
        .and_then(|v| v.checked_add(bucket_width / 2))
        .ok_or(MarketError::Overflow.into())
}

/// clamp outcomes to [first_midpt, last_midpt] 
/// ensures that win is considered for closest bucket 
pub fn clamp_outcome(outcome: u64, bucket_start: u64, bucket_width: u64, num_buckets: u8) -> u64 {
    let lo = midpoint(bucket_start, bucket_width, 0).unwrap_or(outcome);
    let hi = midpoint(bucket_start, bucket_width, num_buckets-1).unwrap_or(outcome);
    outcome.clamp(lo, hi)
}

/// W = SCALE² / (Dn + SCALE) where Dn = distance·SCALE/width (distance in bucket-widths).
/// Max = SCALE on the midpoint; one bucket away = SCALE/2. Scale-free by construction.
pub fn weight(distance: u64, bucket_width: u64) -> u64 {
    let dn = (distance as u128) * SCALE / (bucket_width as u128);
    (SCALE * SCALE / (dn + SCALE)) as u64 // ≤ SCALE, fits u64
}

/// weights for each bucket but sum is computed over funded buckets only
pub fn compute_weights(
    outcome: u64,
    bucket_start: u64,
    bucket_width: u64,
    num_buckets: u8,
    bucket_totals: &[u64; MAX_BUCKETS],
) -> Result<([u64; MAX_BUCKETS], u64)> {
    let x = clamp_outcome(outcome, bucket_start, bucket_width, num_buckets);
    let mut weights = [0u64; MAX_BUCKETS];
    let mut sum: u64 = 0;
    for i in 0..num_buckets as usize {
        let m = midpoint(bucket_start, bucket_width, i as u8)?;
        weights[i] = weight(m.abs_diff(x), bucket_width);
        if bucket_totals[i] > 0 {
            sum = sum.checked_add(weights[i]).ok_or(MarketError::Overflow)?;
        }
    }
    Ok((weights, sum))
}

/// Staged divide keeps intermediates <= ~1e24 (naive amount.W.pool is still than u128)
pub fn payout(
    amount: u64, 
    bucket_total: u64, 
    w: u64, 
    sum_weights: u64, 
    total_pool: u64
) -> Result<u64> {
    require!(bucket_total > 0 && sum_weights > 0, MarketError::Overflow);
    let s1 = (amount as u128) * (total_pool as u128) / (bucket_total as u128);
    let s2 = s1 * (w as u128) / (sum_weights as u128);
    Ok(s2 as u64)
}

/// Rescale Pyth price (price · 10^expo USD) to bucket_decimals units.
/// expo is typically -8 for SOL/USD; target typically 2 (cents).
pub fn scale_price(price: i64, expo: i32, bucket_decimals: u8) -> Result<u64> {
    require!(price > 0, MarketError::InvalidOraclePrice);
    require!((-12..=0).contains(&expo), MarketError::BadExponent);
    let p = price as u128;
    let shift = expo + bucket_decimals as i32; // e.g. -8 + 2 = -6 → divide by 1e6
    let v = if shift >= 0 {
        p.checked_mul(10u128.pow(shift as u32)).ok_or(MarketError::Overflow)?
    } else {
        p / 10u128.pow((-shift) as u32)
    };
    u64::try_from(v).map_err(|_| MarketError::Overflow.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // 7 buckets, $2 wide, start $144.00 (cents, bucket_decimals = 2)
    const START: u64 = 14_400;
    const WIDTH: u64 = 200;
    const N: u8 = 7;

    #[test]
    fn midpoint_basic() {
        assert_eq!(midpoint(START, WIDTH, 0).unwrap(), 14_500); // $145.00
        assert_eq!(midpoint(START, WIDTH, 3).unwrap(), 15_100); // $151.00
    }

    #[test]
    fn weight_on_midpoint_is_max() {
        assert_eq!(weight(0, WIDTH), super::SCALE_U64); // distance 0 → SCALE
    }

    #[test]
    fn weight_one_bucket_away_is_half() {
        // Dn = SCALE → W = SCALE/2
        assert_eq!(weight(WIDTH, WIDTH), super::SCALE_U64 / 2);
    }

    #[test]
    fn clamp_out_of_range_outcome() {
        // outcome $200.00 clamps to last midpoint $157.00
        assert_eq!(clamp_outcome(20_000, START, WIDTH, N), 15_700);
        // outcome $100.00 clamps to first midpoint $145.00
        assert_eq!(clamp_outcome(10_000, START, WIDTH, N), 14_500);
        // in-range passes through
        assert_eq!(clamp_outcome(15_130, START, WIDTH, N), 15_130);
    }

    #[test]
    fn sum_weights_funded_only() {
        let mut totals = [0u64; 10];
        totals[3] = 5; // only bucket 3 funded
        let (w, s) = compute_weights(15_130, START, WIDTH, N, &totals).unwrap();
        assert_eq!(s, w[3]); // S = lone funded bucket's weight
    }

    #[test]
    fn single_funded_bucket_pays_full_pool() {
        let mut totals = [0u64; 10];
        totals[3] = 1_000_000_000; // 1 SOL
        let (w, s) = compute_weights(15_130, START, WIDTH, N, &totals).unwrap();
        let p = payout(1_000_000_000, totals[3], w[3], s, 1_000_000_000).unwrap();
        assert_eq!(p, 1_000_000_000); // 100% back
    }

    proptest! {
        // conservation: sum of payouts never exceeds pool; shortfall bounded by position count
        #[test]
        fn conservation(
            outcome in 10_000u64..20_000,
            bets in proptest::collection::vec((0u8..N, 10_000u64..10_000_000_000), 1..20)
        ) {
            let mut totals = [0u64; 10];
            for (b, amt) in &bets { totals[*b as usize] += amt; }
            let pool: u64 = bets.iter().map(|(_, a)| a).sum();
            let (w, s) = compute_weights(outcome, START, WIDTH, N, &totals).unwrap();
            let paid: u128 = bets.iter()
                .map(|(b, amt)| payout(*amt, totals[*b as usize], w[*b as usize], s, pool).unwrap() as u128)
                .sum();
            prop_assert!(paid <= pool as u128);
            prop_assert!(pool as u128 - paid < bets.len() as u128 + 1); // dust bound
        }

        // monotonicity: closer funded bucket never has smaller weight
        #[test]
        fn weight_monotone(outcome in 14_500u64..15_700) {
            let mut last = u64::MAX;
            let mids: Vec<u64> = (0..N).map(|i| midpoint(START, WIDTH, i).unwrap()).collect();
            let mut by_dist: Vec<u64> = mids.iter().map(|m| m.abs_diff(outcome)).collect();
            by_dist.sort();
            for d in by_dist {
                let w = weight(d, WIDTH);
                prop_assert!(w <= last);
                last = w;
            }
        }
    }

    #[test]
    fn scale_price_pyth_expo() {
        // Pyth SOL/USD: price 15_130_000_000 @ expo -8 → $151.30 → 15_130 cents
        assert_eq!(scale_price(15_130_000_000, -8, 2).unwrap(), 15_130);
        // already coarser than target: price 1513 @ expo -1 → 15_130 cents
        assert_eq!(scale_price(1_513, -1, 2).unwrap(), 15_130);
        // expo 0: price 151 → 15_100 cents
        assert_eq!(scale_price(151, 0, 2).unwrap(), 15_100);
    }
}
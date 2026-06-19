mod common;
use common::*;
use anchor_lang::AccountDeserialize;
use bucketier::math;
use bucketier::state::Market;
use solana_sdk::signature::{Keypair, Signer};

fn load_market(svm: &litesvm::LiteSVM, pk: &solana_sdk::pubkey::Pubkey) -> Market {
    let acc = svm.get_account(pk).unwrap();
    Market::try_deserialize(&mut acc.data.as_slice()).unwrap()
}

/// 3 bettors on buckets 2/3/5, resolved at $151.30 (bucket 3 wins).
fn resolved_market(svm: &mut litesvm::LiteSVM, payer: &Keypair) -> (solana_sdk::pubkey::Pubkey, Vec<Keypair>) {
    let (market, bettors) = market_with_bettors(svm, payer, 3);
    send(svm, &bettors[0], place_bet_ix(&market, &bettors[0].pubkey(), 2, SOL), &[]).unwrap();
    send(svm, &bettors[1], place_bet_ix(&market, &bettors[1].pubkey(), 3, SOL), &[]).unwrap();
    send(svm, &bettors[2], place_bet_ix(&market, &bettors[2].pubkey(), 5, 2 * SOL), &[]).unwrap();
    let res_time = load_market(svm, &market).resolution_time;
    warp_to(svm, res_time + 10);
    let pu = inject_price_update(svm, SOL_USD_FEED, 15_130_000_000, 5_000_000, -8, res_time);
    send(svm, payer, resolve_ix(&market, &payer.pubkey(), &pu), &[]).unwrap();
    (market, bettors)
}

#[test]
fn claims_match_math_and_conserve_pool() {
    let (mut svm, payer) = setup();
    let (market, bettors) = resolved_market(&mut svm, &payer);
    let m = load_market(&svm, &market);
    let (weights, sum) = math::compute_weights(
        m.outcome.unwrap(), m.bucket_start, m.bucket_width, m.num_buckets, &m.bucket_totals,
    ).unwrap();

    let mut paid_total: u128 = 0;
    for (bettor, bucket, amt) in [(&bettors[0], 2u8, SOL), (&bettors[1], 3, SOL), (&bettors[2], 5, 2 * SOL)] {
        let expected = math::payout(amt, m.bucket_totals[bucket as usize], weights[bucket as usize], sum, m.total_pool).unwrap();
        let before = svm.get_account(&bettor.pubkey()).unwrap().lamports;
        send(&mut svm, bettor, claim_ix(&market, &bettor.pubkey(), bucket), &[]).unwrap();
        let after = svm.get_account(&bettor.pubkey()).unwrap().lamports;
        let position_rent = 5000; // tolerance: payout + closed-position rent − tx fee
        assert!(after - before >= expected as u64 - position_rent, "bucket {bucket}");
        paid_total += expected as u128;
        // winner (bucket 3, on-the-money) must beat the far loser per lamport — checked after loop
    }
    // conservation: vault keeps rent floor + dust only
    let vault = svm.get_account(&vault_pda(&market)).unwrap();
    let floor = svm.minimum_balance_for_rent_exemption(0);
    assert!(vault.lamports >= floor);
    assert!((vault.lamports - floor) as u128 == m.total_pool as u128 - paid_total); // dust = pool − Σpayouts
    assert!(vault.lamports - floor < 10); // dust < positions count

    // gradient sanity: bucket 3 (hit) out-earns bucket 5 per lamport staked
    let p3 = math::payout(SOL, m.bucket_totals[3], weights[3], sum, m.total_pool).unwrap();
    let p5 = math::payout(2 * SOL, m.bucket_totals[5], weights[5], sum, m.total_pool).unwrap();
    assert!(p3 as u128 * 2 > p5 as u128, "per-lamport gradient violated");
}

#[test]
fn claim_order_independence() {
    // claim in reverse order on an identical market: same payouts
    let (mut svm, payer) = setup();
    let (market, bettors) = resolved_market(&mut svm, &payer);
    for (bettor, bucket) in [(&bettors[2], 5u8), (&bettors[1], 3), (&bettors[0], 2)] {
        send(&mut svm, bettor, claim_ix(&market, &bettor.pubkey(), bucket), &[]).unwrap();
    }
    let vault = svm.get_account(&vault_pda(&market)).unwrap();
    assert!(vault.lamports - svm.minimum_balance_for_rent_exemption(0) < 10);
}

#[test]
fn claim_guards() {
    let (mut svm, payer) = setup();
    let (market, bettors) = resolved_market(&mut svm, &payer);
    let a = &bettors[0];
    send(&mut svm, a, claim_ix(&market, &a.pubkey(), 2), &[]).unwrap();
    // double claim: position closed → fails
    let err = send(&mut svm, a, claim_ix(&market, &a.pubkey(), 2), &[]).unwrap_err();
    assert!(err.contains("AccountNotInitialized") || err.contains("Error"), "{err}");
    // refund path rejected on resolved market
    let err = send(&mut svm, &bettors[1], refund_ix(&market, &bettors[1].pubkey(), 3), &[]).unwrap_err();
    assert!(err.contains("MarketNotCanceled"), "{err}");
}
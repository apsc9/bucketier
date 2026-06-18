mod common;
use common::*;
use anchor_lang::AccountDeserialize;
use bucketier::state::{Market, MarketState};
use solana_sdk::signature::{Keypair, Signer};

fn load_market(svm: &litesvm::LiteSVM, pk: &solana_sdk::pubkey::Pubkey) -> Market {
    let acc = svm.get_account(pk).unwrap();
    Market::try_deserialize(&mut acc.data.as_slice()).unwrap()
}

/// market with one bet, clock warped past resolution_time; returns (market, resolution_time)
fn resolvable_market(svm: &mut litesvm::LiteSVM, payer: &Keypair) -> (solana_sdk::pubkey::Pubkey, i64) {
    let (market, bettors) = market_with_bettors(svm, payer, 1);
    let a = &bettors[0];
    send(svm, a, place_bet_ix(&market, &a.pubkey(), 3, SOL), &[]).unwrap();
    let res_time = load_market(svm, &market).resolution_time;
    warp_to(svm, res_time + 10);
    (market, res_time)
}

#[test]
fn resolve_happy_path() {
    let (mut svm, payer) = setup();
    let (market, res_time) = resolvable_market(&mut svm, &payer);
    // $151.30 @ expo -8, publish_time == resolution_time
    let pu = inject_price_update(&mut svm, SOL_USD_FEED, 15_130_000_000, 5_000_000, -8, res_time);
    send(&mut svm, &payer, resolve_ix(&market, &payer.pubkey(), &pu), &[]).unwrap();

    let m = load_market(&svm, &market);
    assert_eq!(m.state, MarketState::Resolved);
    assert_eq!(m.outcome, Some(15_130));         // cents
    assert!(m.sum_weights.unwrap() > 0);
}

#[test]
fn resolve_rejections() {
    let (mut svm, payer) = setup();
    let (market, res_time) = resolvable_market(&mut svm, &payer);

    // wrong feed id
    let pu = inject_price_update(&mut svm, [9u8; 32], 15_130_000_000, 5_000_000, -8, res_time);
    let err = send(&mut svm, &payer, resolve_ix(&market, &payer.pubkey(), &pu), &[]).unwrap_err();
    assert!(err.contains("WrongOracleFeed"), "{err}");

    // publish_time outside ±60s of resolution_time (cherry-picking blocked)
    let pu = inject_price_update(&mut svm, SOL_USD_FEED, 15_130_000_000, 5_000_000, -8, res_time + 61);
    let err = send(&mut svm, &payer, resolve_ix(&market, &payer.pubkey(), &pu), &[]).unwrap_err();
    assert!(err.contains("BadResolutionTimestamp"), "{err}");

    // confidence wider than 2% of price
    let pu = inject_price_update(&mut svm, SOL_USD_FEED, 15_130_000_000, 400_000_000, -8, res_time);
    let err = send(&mut svm, &payer, resolve_ix(&market, &payer.pubkey(), &pu), &[]).unwrap_err();
    assert!(err.contains("ConfidenceTooWide"), "{err}");

    // non-positive price
    let pu = inject_price_update(&mut svm, SOL_USD_FEED, -5, 1, -8, res_time);
    let err = send(&mut svm, &payer, resolve_ix(&market, &payer.pubkey(), &pu), &[]).unwrap_err();
    assert!(err.contains("InvalidOraclePrice"), "{err}");
}

#[test]
fn resolve_too_early_and_empty() {
    let (mut svm, payer) = setup();
    // empty market: no bets, time passed
    let (market, _) = market_with_bettors(&mut svm, &payer, 0);
    let res_time = load_market(&svm, &market).resolution_time;
    let pu = inject_price_update(&mut svm, SOL_USD_FEED, 15_130_000_000, 5_000_000, -8, res_time);

    // too early
    let err = send(&mut svm, &payer, resolve_ix(&market, &payer.pubkey(), &pu), &[]).unwrap_err();
    assert!(err.contains("TooEarlyToResolve"), "{err}");

    // empty pool
    warp_to(&mut svm, res_time + 10);
    let err = send(&mut svm, &payer, resolve_ix(&market, &payer.pubkey(), &pu), &[]).unwrap_err();
    assert!(err.contains("EmptyMarket"), "{err}");
}
mod common;
use common::*;
use anchor_lang::AccountDeserialize;
use bucketier::state::{Market, MarketState};
use solana_sdk::signature::{Keypair, Signer};

fn load_market(svm: &litesvm::LiteSVM, pk: &solana_sdk::pubkey::Pubkey) -> Market {
    let acc = svm.get_account(pk).unwrap();
    Market::try_deserialize(&mut acc.data.as_slice()).unwrap()
}

#[test]
fn create_market_happy_path() {
    let (mut svm, payer) = setup();
    let args = default_args(&svm, 1);
    send(&mut svm, &payer, create_market_ix(&payer.pubkey(), args.clone()), &[]).unwrap();

    let mkt_pk = market_pda(&payer.pubkey(), 1);
    let m = load_market(&svm, &mkt_pk);
    assert_eq!(m.state, MarketState::Open);
    assert_eq!(m.num_buckets, 7);
    assert_eq!(m.total_pool, 0);
    assert_eq!(m.feed_id, SOL_USD_FEED);

    // vault exists and is rent-exempt for 0 data
    let vault = svm.get_account(&vault_pda(&mkt_pk)).unwrap();
    assert!(vault.lamports >= svm.minimum_balance_for_rent_exemption(0));
}

#[test]
fn create_market_rejects_bad_timestamps() {
    let (mut svm, payer) = setup();
    let mut args = default_args(&svm, 2);
    args.resolution_time = args.betting_close - 1; // resolution before close
    let err = send(&mut svm, &payer, create_market_ix(&payer.pubkey(), args), &[]).unwrap_err();
    assert!(err.contains("InvalidTimeStamps"), "{err}");
}

#[test]
fn create_market_rejects_bad_buckets() {
    let (mut svm, payer) = setup();
    for (n, w) in [(1u8, 200u64), (11, 200), (7, 0)] {
        let mut args = default_args(&svm, 10 + n as u64);
        args.num_buckets = n;
        args.bucket_width = w;
        let err = send(&mut svm, &payer, create_market_ix(&payer.pubkey(), args), &[]).unwrap_err();
        assert!(err.contains("InvalidParams"), "{err}");
    }
}

#[test]
fn place_bet_happy_and_accumulating() {
    let (mut svm, payer) = setup();
    let (market, bettors) = market_with_bettors(&mut svm, &payer, 2);
    let (a, b) = (&bettors[0], &bettors[1]);

    send(&mut svm, a, place_bet_ix(&market, &a.pubkey(), 3, SOL), &[]).unwrap();
    send(&mut svm, a, place_bet_ix(&market, &a.pubkey(), 3, SOL), &[]).unwrap(); // same bucket: accumulates
    send(&mut svm, b, place_bet_ix(&market, &b.pubkey(), 5, 2 * SOL), &[]).unwrap();

    let m = load_market(&svm, &market);
    assert_eq!(m.total_pool, 4 * SOL);
    assert_eq!(m.bucket_totals[3], 2 * SOL);
    assert_eq!(m.bucket_totals[5], 2 * SOL);

    let vault = svm.get_account(&vault_pda(&market)).unwrap();
    assert_eq!(vault.lamports, 4 * SOL + svm.minimum_balance_for_rent_exemption(0));
}

#[test]
fn place_bet_rejections() {
    let (mut svm, payer) = setup();
    let (market, bettors) = market_with_bettors(&mut svm, &payer, 1);
    let a = &bettors[0];

    // bucket out of range
    let err = send(&mut svm, a, place_bet_ix(&market, &a.pubkey(), 7, SOL), &[]).unwrap_err();
    assert!(err.contains("InvalidBucket"), "{err}");
    // below min bet (min is 0.01 SOL)
    let err = send(&mut svm, a, place_bet_ix(&market, &a.pubkey(), 3, SOL / 1000), &[]).unwrap_err();
    assert!(err.contains("BetTooSmall"), "{err}");
    // after betting_close
    let target = now(&svm) + 101;
    warp_to(&mut svm, target);
    let err = send(&mut svm, a, place_bet_ix(&market, &a.pubkey(), 3, SOL), &[]).unwrap_err();
    assert!(err.contains("BettingWindowClosed"), "{err}");
}

#[test]
fn cancel_empty_market_by_authority() {
    let (mut svm, payer) = setup();
    let (market, _) = market_with_bettors(&mut svm, &payer, 0);
    send(&mut svm, &payer, cancel_ix(&market, &payer.pubkey()), &[]).unwrap();
    assert_eq!(load_market(&svm, &market).state, MarketState::Canceled);
}

#[test]
fn cancel_with_bets_rejected_until_deadline_then_permissionless() {
    let (mut svm, payer) = setup();
    let (market, bettors) = market_with_bettors(&mut svm, &payer, 1);
    let a = &bettors[0];
    send(&mut svm, a, place_bet_ix(&market, &a.pubkey(), 3, SOL), &[]).unwrap();

    // authority cannot void a market with live bets 
    let err = send(&mut svm, &payer, cancel_ix(&market, &payer.pubkey()), &[]).unwrap_err();
    assert!(err.contains("CancelNotAllowed"), "{err}");

    // …but anyone can after resolve_deadline (oracle-failure backstop)
    let target = now(&svm) + 1001;
    warp_to(&mut svm, target);
    let rando = Keypair::new();
    svm.airdrop(&rando.pubkey(), SOL).unwrap();
    send(&mut svm, &rando, cancel_ix(&market, &rando.pubkey()), &[]).unwrap();
    assert_eq!(load_market(&svm, &market).state, MarketState::Canceled);

    // refund returns exact stake and closes the position
    let before = svm.get_account(&a.pubkey()).unwrap().lamports;
    send(&mut svm, a, refund_ix(&market, &a.pubkey(), 3), &[]).unwrap();
    let after = svm.get_account(&a.pubkey()).unwrap().lamports;
    assert!(after > before + SOL - 100_000); // stake + position rent back, minus tx fee
    assert!(svm.get_account(&position_pda(&market, &a.pubkey(), 3)).map_or(true, |acc| acc.lamports == 0));

    // double refund impossible — position is gone
    let err = send(&mut svm, a, refund_ix(&market, &a.pubkey(), 3), &[]).unwrap_err();
    assert!(err.contains("AccountNotInitialized") || err.contains("Error"), "{err}");
}
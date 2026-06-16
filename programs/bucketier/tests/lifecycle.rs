mod common;
use common::*;
use anchor_lang::AccountDeserialize;
use bucketier::state::{Market, MarketState};
use solana_sdk::signature::Signer;

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
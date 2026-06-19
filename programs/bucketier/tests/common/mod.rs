use anchor_lang::AnchorSerialize;
use bucketier::state::{MARKET_SEED, POSITION_SEED, VAULT_SEED};
use litesvm::LiteSVM;
use solana_sdk::{
    clock::Clock,
    hash::hash as sha256,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};
use bucketier::pyth::{PriceFeedMessage, PriceUpdateV2, VerificationLevel,
    PYTH_RECEIVER_ID, PRICE_UPDATE_V2_DISCRIMINATOR};
use solana_sdk::account::Account as SolanaAccount;

pub const SOL: u64 = 1_000_000_000;
pub const SOL_USD_FEED: [u8; 32] = [7u8; 32]; // arbitrary in tests — must just match market.feed_id

pub fn program_id() -> Pubkey {
    Pubkey::new_from_array(bucketier::ID.to_bytes())
}

pub fn setup() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(program_id(), "../../target/deploy/bucketier.so")
        .expect("run `anchor build` first");
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100 * SOL).unwrap();
    (svm, payer)
}

pub fn warp_to(svm: &mut LiteSVM, unix_ts: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = unix_ts;
    svm.set_sysvar(&clock);
}

pub fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

pub fn market_pda(authority: &Pubkey, market_id: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[MARKET_SEED, authority.as_ref(), &market_id.to_le_bytes()],
        &program_id(),
    )
    .0
}

pub fn vault_pda(market: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[VAULT_SEED, market.as_ref()], &program_id()).0
}

pub fn position_pda(market: &Pubkey, owner: &Pubkey, bucket: u8) -> Pubkey {
    Pubkey::find_program_address(
        &[POSITION_SEED, market.as_ref(), owner.as_ref(), &[bucket]],
        &program_id(),
    )
    .0
}

// Anchor custom errors start at 6000; map code → variant name for readable assertions
fn anchor_error_name(code: u32) -> &'static str {
    match code {
        6000 => "MarketNotOpen",
        6001 => "MarketNotResolved",
        6002 => "MarketNotCanceled",
        6003 => "InvalidParams",
        6004 => "InvalidTimeStamps",
        6005 => "BettingWindowClosed",
        6006 => "BetTooSmall",
        6007 => "InvalidBucket",
        6008 => "TooEarlyToResolve",
        6009 => "EmptyMarket",
        6010 => "WrongOracleFeed",
        6011 => "BadResolutionTimestamp",
        6012 => "InvalidOraclePrice",
        6013 => "ConfidenceTooWide",
        6014 => "BadExponent",
        6015 => "CancelNotAllowed",
        6016 => "Overflow",
        _ => "Unknown",
    }
}

fn decode_tx_error(raw: &str) -> String {
    // Extract Custom(NNNN) code from debug output and prepend the Anchor error name
    if let Some(start) = raw.find("Custom(") {
        let after = &raw[start + 7..];
        if let Some(end) = after.find(')') {
            if let Ok(code) = after[..end].parse::<u32>() {
                return format!("{} [{}]", anchor_error_name(code), raw);
            }
        }
    }
    raw.to_string()
}

pub fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    ix: Instruction,
    extra_signers: &[&Keypair],
) -> std::result::Result<(), String> {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra_signers);
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &signers,
        svm.latest_blockhash(),
    );
    let result = svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| decode_tx_error(&format!("{:?}", e.err)));
    svm.expire_blockhash();
    result
}

fn anchor_disc(name: &str) -> Vec<u8> {
    let hash = sha256(format!("global:{}", name).as_bytes());
    hash.to_bytes()[..8].to_vec()
}

/// Default demo-shaped market args relative to current SVM clock.
/// 7 buckets x $2 around $151, cents scale; betting open now..+100s; resolve +100s; deadline +1000s.
pub fn default_args(svm: &LiteSVM, market_id: u64) -> bucketier::instructions::CreateMarketArgs {
    let t = now(svm);
    bucketier::instructions::CreateMarketArgs {
        market_id,
        feed_id: SOL_USD_FEED,
        bucket_decimals: 2,
        bucket_start: 14_400, // $144.00
        bucket_width: 200,    // $2.00
        num_buckets: 7,
        min_bet: SOL / 100,   // 0.01 SOL
        betting_open: t,
        betting_close: t + 100,
        resolution_time: t + 100,
        resolve_deadline: t + 1000,
    }
}

pub fn create_market_ix(
    authority: &Pubkey,
    args: bucketier::instructions::CreateMarketArgs,
) -> Instruction {
    let market = market_pda(authority, args.market_id);
    let vault = vault_pda(&market);

    let mut data = anchor_disc("create_market");
    let mut args_buf = Vec::new();
    args.serialize(&mut args_buf).unwrap();
    data.extend(args_buf);

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*authority, true),
            AccountMeta::new(market, false),
            AccountMeta::new(vault, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data,
    }
}

pub fn place_bet_ix(market: &Pubkey, bettor: &Pubkey, bucket: u8, amount: u64) -> Instruction {
    let mut data = anchor_disc("place_bet");
    let mut buf = Vec::new();
    bucket.serialize(&mut buf).unwrap();
    amount.serialize(&mut buf).unwrap();
    data.extend(buf);

    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*bettor, true),
            AccountMeta::new(*market, false),
            AccountMeta::new(position_pda(market, bettor, bucket), false),
            AccountMeta::new(vault_pda(market), false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data,
    }
}

/// create market id=1 with default args + n funded bettors; returns (market_pk, bettors)
pub fn market_with_bettors(svm: &mut LiteSVM, payer: &Keypair, n: usize) -> (Pubkey, Vec<Keypair>) {
    let args = default_args(svm, 1);
    send(svm, payer, create_market_ix(&payer.pubkey(), args), &[]).unwrap();
    let market = market_pda(&payer.pubkey(), 1);
    let bettors: Vec<Keypair> = (0..n).map(|_| {
        let k = Keypair::new();
        svm.airdrop(&k.pubkey(), 50 * SOL).unwrap();
        k
    }).collect();
    (market, bettors)
}

pub fn cancel_ix(market: &Pubkey, caller: &Pubkey) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(*caller, true),
            AccountMeta::new(*market, false),
        ],
        data: anchor_disc("cancel_market"),
    }
}

pub fn refund_ix(market: &Pubkey, owner: &Pubkey, bucket: u8) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new_readonly(*market, false),
            AccountMeta::new(position_pda(market, owner, bucket), false),
            AccountMeta::new(vault_pda(market), false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data: anchor_disc("claim_refund"),
    }
}


/// Fabricate a PriceUpdateV2 owned by the Pyth receiver program directly in the SVM.
/// PriceUpdateV2 is plain Borsh + discriminator — no Hermes/Wormhole needed in tests.
/// Note: PriceUpdateV2.write_authority is Anchor's v3 Pubkey; use anchor_lang::prelude::Pubkey
/// for construction. PYTH_RECEIVER_ID is also v3; convert to v2 for SolanaAccount.owner.
pub fn inject_price_update(
    svm: &mut LiteSVM,
    feed_id: [u8; 32],
    price: i64,
    conf: u64,
    exponent: i32,
    publish_time: i64,
) -> Pubkey {
    let update = PriceUpdateV2 {
        write_authority: anchor_lang::prelude::Pubkey::default(),
        verification_level: VerificationLevel::Full,
        price_message: PriceFeedMessage {
            feed_id,
            price,
            conf,
            exponent,
            publish_time,
            prev_publish_time: publish_time,
            ema_price: price,
            ema_conf: conf,
        },
        posted_slot: 1,
    };
    let mut data = PRICE_UPDATE_V2_DISCRIMINATOR.to_vec();
    let mut update_buf = Vec::new();
    update.serialize(&mut update_buf).unwrap();
    data.extend(update_buf);
    let pk = Pubkey::new_unique();
    // Convert PYTH_RECEIVER_ID (Anchor v3 Pubkey) → solana-sdk v2 Pubkey for SolanaAccount.owner
    let pyth_owner = Pubkey::new_from_array(PYTH_RECEIVER_ID.to_bytes());
    svm.set_account(pk, SolanaAccount {
        lamports: 10_000_000,
        data,
        owner: pyth_owner,
        executable: false,
        rent_epoch: 0,
    }).unwrap();
    pk
}

pub fn resolve_ix(market: &Pubkey, caller: &Pubkey, price_update: &Pubkey) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new_readonly(*caller, true),
            AccountMeta::new(*market, false),
            AccountMeta::new_readonly(*price_update, false),
        ],
        data: anchor_disc("resolve_market"),
    }
}

pub fn claim_ix(market: &Pubkey, owner: &Pubkey, bucket: u8) -> Instruction {
    Instruction { 
        program_id: program_id(), 
        accounts: vec![
            AccountMeta::new(*owner, true),
            AccountMeta::new_readonly(*market, false),
            AccountMeta::new(position_pda(market, owner, bucket), false),
            AccountMeta::new(vault_pda(market), false),
            AccountMeta::new_readonly(system_program::ID, false),
        ], 
        data: anchor_disc("claim"), 
    }
}

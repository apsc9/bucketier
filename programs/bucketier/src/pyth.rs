use anchor_lang::prelude::*;

pub const PYTH_RECEIVER_ID: Pubkey =
    Pubkey::from_str_const("rec5EKMGg6MxZYaMdyBps68Vr6X7qAye4SYiKJHSHfq");

pub const PRICE_UPDATE_V2_DISCRIMINATOR: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Debug)]
pub enum VerificationLevel {
    Partial { num_signatures: u8 },
    Full,
}

#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, PartialEq, Debug)]
pub struct PriceFeedMessage {
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
    pub prev_publish_time: i64,
    pub ema_price: i64,
    pub ema_conf: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PriceUpdateV2 {
    pub write_authority: Pubkey,
    pub verification_level: VerificationLevel,
    pub price_message: PriceFeedMessage,
    pub posted_slot: u64,
}

impl PriceUpdateV2 {
    pub const LEN: usize = 32 + 1 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8;

    pub fn try_deserialize(data: &[u8]) -> Result<Self> {
        require!(data.len() >= 8 + Self::LEN, ErrorCode::AccountDidNotDeserialize);
        AnchorDeserialize::deserialize(&mut &data[8..])
            .map_err(|_| ErrorCode::AccountDidNotDeserialize.into())
    }
}

pub fn get_feed_id_from_hex(input: &str) -> std::result::Result<[u8; 32], ProgramError> {
    let hex_str = if input.starts_with("0x") {
        &input[2..]
    } else {
        input
    };
    if hex_str.len() != 64 {
        return Err(ProgramError::InvalidArgument);
    }
    let mut feed_id = [0u8; 32];
    for i in 0..32 {
        feed_id[i] = u8::from_str_radix(&hex_str[i * 2..i * 2 + 2], 16)
            .map_err(|_| ProgramError::InvalidArgument)?;
    }
    Ok(feed_id)
}

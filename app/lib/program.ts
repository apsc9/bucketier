import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

export const SOL_USD_HEX =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
export const SOL_USD_FEED = Array.from(Buffer.from(SOL_USD_HEX, "hex"));

export const MARKET = new PublicKey(
  process.env.NEXT_PUBLIC_MARKET || "11111111111111111111111111111111"
);

export function marketPda(
  programId: PublicKey,
  authority: PublicKey,
  marketId: number
) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      authority.toBuffer(),
      new anchor.BN(marketId).toArrayLike(Buffer, "le", 8),
    ],
    programId
  )[0];
}

export function vaultPda(programId: PublicKey, market: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()],
    programId
  )[0];
}

export function positionPda(
  programId: PublicKey,
  market: PublicKey,
  owner: PublicKey,
  bucket: number
) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      market.toBuffer(),
      owner.toBuffer(),
      Buffer.from([bucket]),
    ],
    programId
  )[0];
}

export const fmt$ = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export const fmtSOL = (lamports: number) =>
  `${(lamports / 1_000_000_000).toFixed(4)}`;

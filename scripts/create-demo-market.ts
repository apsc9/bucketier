import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "fs";

const SOL_USD_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

async function main() {
  const rpc = process.env.HELIUS_DEVNET_RPC ?? "https://api.devnet.solana.com";
  const keypairPath = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))));
  const connection = new Connection(rpc, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync("target/idl/bucketier.json", "utf8"));
  const program = new anchor.Program(idl, provider);
  const authority = wallet.publicKey;

  const bettingWindow = Number(process.argv[2] ?? 300); // default 5 minutes

  // Fetch spot price from Pyth Hermes
  const res = await fetch(
    `https://hermes.pyth.network/v2/updates/price/latest?ids%5B%5D=0x${SOL_USD_HEX}&parsed=true`
  );
  if (!res.ok) throw new Error(`Hermes ${res.status}`);
  const json = await res.json();
  const p = json.parsed[0].price;
  const spotCents = Math.round(Number(p.price) * Math.pow(10, p.expo) * 100);

  // 7 buckets × $1 centered on spot
  const numBuckets = 7;
  const bucketWidth = 100;
  const bucketStart = spotCents - Math.floor((numBuckets * bucketWidth) / 2);
  const feedId = Array.from(Buffer.from(SOL_USD_HEX, "hex"));
  const marketId = Date.now() % 100000;
  const now = Math.floor(Date.now() / 1000);

  const [market] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), authority.toBuffer(), new anchor.BN(marketId).toArrayLike(Buffer, "le", 8)],
    program.programId
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()],
    program.programId
  );

  await program.methods
    .createMarket({
      marketId: new anchor.BN(marketId),
      feedId,
      bucketDecimals: 2,
      bucketStart: new anchor.BN(bucketStart),
      bucketWidth: new anchor.BN(bucketWidth),
      numBuckets,
      minBet: new anchor.BN(0.01 * 1e9),
      bettingOpen: new anchor.BN(now),
      bettingClose: new anchor.BN(now + bettingWindow),
      resolutionTime: new anchor.BN(now + bettingWindow),
      resolveDeadline: new anchor.BN(now + bettingWindow + 3600),
    })
    .accounts({ authority, market, vault, systemProgram: SystemProgram.programId })
    .rpc();

  console.log(`\nNEXT_PUBLIC_MARKET=${market.toBase58()}`);
  console.log(`\nSOL/USD spot: $${(spotCents / 100).toFixed(2)}`);
  console.log(`Buckets: $${(bucketStart / 100).toFixed(2)} → $${((bucketStart + numBuckets * bucketWidth) / 100).toFixed(2)} (7 × $1.00)`);
  console.log(`Betting closes in ${bettingWindow}s at ${new Date((now + bettingWindow) * 1000).toLocaleTimeString()}`);
  console.log(`Resolution at ${new Date((now + bettingWindow) * 1000).toLocaleTimeString()}`);
  console.log(`Resolve deadline: ${new Date((now + bettingWindow + 3600) * 1000).toLocaleTimeString()}`);
}

main().catch(console.error);

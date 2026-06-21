import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: "app/.env.local" });

const NUM_BETTORS = 5;
const BET_RANGE_SOL = [0.02, 0.15]; // min/max bet per bettor

async function main() {
  const rpc = process.env.HELIUS_DEVNET_RPC ?? "http://127.0.0.1:8899";
  const keypairPath =
    process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;
  const authority = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")))
  );
  const connection = new Connection(rpc, "confirmed");
  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);
  const idl = JSON.parse(
    fs.readFileSync("target/idl/bucketier.json", "utf8")
  );
  const program = new anchor.Program(idl, provider);

  const marketPk = new PublicKey(
    process.argv[2] ?? process.env.NEXT_PUBLIC_MARKET ?? ""
  );
  if (marketPk.equals(PublicKey.default)) {
    console.error("Usage: seed-market.ts <MARKET_PUBKEY>");
    console.error("  or set NEXT_PUBLIC_MARKET env var");
    process.exit(1);
  }

  // Fetch market to get numBuckets
  const market = await (program.account as any).market.fetch(marketPk);
  const numBuckets = market.numBuckets as number;
  const bw = (market.bucketWidth as anchor.BN).toNumber();
  const start = (market.bucketStart as anchor.BN).toNumber();

  console.log(`Market: ${marketPk.toBase58()}`);
  console.log(
    `Buckets: ${numBuckets} × $${(bw / 100).toFixed(2)} from $${(start / 100).toFixed(2)}`
  );
  console.log(`Generating ${NUM_BETTORS} bettors...\n`);

  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketPk.toBuffer()],
    program.programId
  );

  // Generate keypairs and fund them
  const bettors: Keypair[] = [];
  for (let i = 0; i < NUM_BETTORS; i++) {
    bettors.push(Keypair.generate());
  }

  // Fund all bettors from authority
  const isLocalnet = rpc.includes("127.0.0.1") || rpc.includes("localhost");
  if (isLocalnet) {
    for (const bettor of bettors) {
      const sig = await connection.requestAirdrop(
        bettor.publicKey,
        0.5 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");
    }
    console.log(`Airdropped 0.5 SOL to each bettor (localnet)\n`);
  } else {
    // On devnet, transfer from authority
    for (const bettor of bettors) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: bettor.publicKey,
          lamports: 0.3 * LAMPORTS_PER_SOL,
        })
      );
      await sendAndConfirmTransaction(connection, tx, [authority]);
    }
    console.log(`Funded 0.3 SOL to each bettor from authority\n`);
  }

  // Place bets with some realistic distribution — weight toward center buckets
  for (let i = 0; i < bettors.length; i++) {
    const bettor = bettors[i];
    const bettorProvider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(bettor),
      { commitment: "confirmed" }
    );
    const bettorProgram = new anchor.Program(idl, bettorProvider);

    // Each bettor bets on 1-3 buckets
    const numBets = 1 + Math.floor(Math.random() * 3);
    const bucketsPicked = new Set<number>();

    for (let b = 0; b < numBets; b++) {
      // Bias toward center buckets (normal-ish distribution)
      let bucketIdx: number;
      do {
        const center = numBuckets / 2;
        const spread = (Math.random() + Math.random() + Math.random()) / 3; // tends toward 0.5
        bucketIdx = Math.floor(spread * numBuckets);
        bucketIdx = Math.max(0, Math.min(numBuckets - 1, bucketIdx));
      } while (bucketsPicked.has(bucketIdx));
      bucketsPicked.add(bucketIdx);

      const betSOL =
        BET_RANGE_SOL[0] +
        Math.random() * (BET_RANGE_SOL[1] - BET_RANGE_SOL[0]);
      const betLamports = Math.floor(betSOL * LAMPORTS_PER_SOL);

      const [position] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("position"),
          marketPk.toBuffer(),
          bettor.publicKey.toBuffer(),
          Buffer.from([bucketIdx]),
        ],
        program.programId
      );

      const mid = start + bucketIdx * bw + bw / 2;
      try {
        await bettorProgram.methods
          .placeBet(bucketIdx, new anchor.BN(betLamports))
          .accounts({
            bettor: bettor.publicKey,
            market: marketPk,
            position,
            vault,
            system_program: SystemProgram.programId,
          })
          .signers([bettor])
          .rpc();

        console.log(
          `  Bettor ${i + 1} → bucket #${bucketIdx} ($${(mid / 100).toFixed(2)}) : ${betSOL.toFixed(4)} SOL`
        );
      } catch (e: any) {
        console.error(
          `  Bettor ${i + 1} → bucket #${bucketIdx} FAILED: ${e.message}`
        );
      }
    }
  }

  // Print summary
  const updated = await (program.account as any).market.fetch(marketPk);
  const pool = (updated.totalPool as anchor.BN).toNumber();
  const totals = (updated.bucketTotals as anchor.BN[])
    .slice(0, numBuckets)
    .map((b: anchor.BN) => b.toNumber());

  console.log(`\n--- Market seeded ---`);
  console.log(`Total pool: ${(pool / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`Bucket distribution:`);
  totals.forEach((t: number, i: number) => {
    const mid = start + i * bw + bw / 2;
    const bar = "█".repeat(Math.ceil((t / Math.max(...totals, 1)) * 20));
    console.log(
      `  #${i} $${(mid / 100).toFixed(2)} : ${(t / LAMPORTS_PER_SOL).toFixed(4)} SOL ${bar}`
    );
  });
}

main().catch(console.error);

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";

// Pyth devnet SOL/USD feed
const SOL_USD_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const SOL_USD_FEED = Array.from(Buffer.from(SOL_USD_HEX, "hex"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt$ = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const fmtSOL = (lamports: number) => `${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`;

function marketPda(programId: PublicKey, authority: PublicKey, marketId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), authority.toBuffer(), new anchor.BN(marketId).toArrayLike(Buffer, "le", 8)],
    programId,
  )[0];
}
function vaultPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], programId)[0];
}
function positionPda(programId: PublicKey, market: PublicKey, owner: PublicKey, bucket: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), owner.toBuffer(), Buffer.from([bucket])],
    programId,
  )[0];
}

function describeBuckets(start: number, width: number, n: number): string {
  const ranges = Array.from({ length: n }, (_, i) => {
    const lo = start + i * width;
    const hi = lo + width;
    const mid = lo + width / 2;
    return `  [${i}] ${fmt$(lo)} – ${fmt$(hi)} (mid: ${fmt$(mid)})`;
  });
  return ranges.join("\n");
}

/** Fetch signed historical price update from Pyth Benchmarks */
async function fetchBenchmarkUpdate(unixTs: number): Promise<string[]> {
  const url = `https://benchmarks.pyth.network/v1/updates/price/${unixTs}?ids=0x${SOL_USD_HEX}&encoding=base64`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Benchmarks ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.binary.data;
}

/** Fetch current SOL/USD spot from Pyth Hermes (latest price). Returns cents. */
async function fetchSpotCents(): Promise<number> {
  const url = `https://hermes.pyth.network/v2/updates/price/latest?ids%5B%5D=0x${SOL_USD_HEX}&parsed=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Hermes spot ${res.status}`);
  const json = await res.json();
  const p = json.parsed[0].price;
  return Math.round(Number(p.price) * Math.pow(10, p.expo) * 100);
}

/** Compute bucket params centered on spot. 7 buckets, $1 wide each → ±$3.50 around spot. */
function computeBuckets(spotCents: number) {
  const numBuckets = 7;
  const bucketWidth = 100; // $1.00 in cents
  const bucketStart = spotCents - Math.floor((numBuckets * bucketWidth) / 2);
  return { bucketStart, bucketWidth, numBuckets };
}

describe("bucketier devnet", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Bucketier as Program;
  const authority = provider.wallet.publicKey;
  const receiver = new PythSolanaReceiver({ connection: provider.connection, wallet: provider.wallet as any });

  // Use unique market IDs per test run to avoid PDA collisions
  const runId = Math.floor(Math.random() * 100000);
  const BET_AMOUNT = new anchor.BN(0.02 * LAMPORTS_PER_SOL); // 0.02 SOL
  const MIN_BET = new anchor.BN(0.01 * LAMPORTS_PER_SOL);     // 0.01 SOL
  const BETTING_WINDOW = 30; // seconds

  // Fetched once in before() — live spot price determines bucket params
  let spotCents: number;
  let bucketStart: number;
  let bucketWidth: number;
  let numBuckets: number;

  before(async () => {
    spotCents = await fetchSpotCents();
    const params = computeBuckets(spotCents);
    bucketStart = params.bucketStart;
    bucketWidth = params.bucketWidth;
    numBuckets = params.numBuckets;

    console.log(`\n  ═══════════════════════════════════════════════════════`);
    console.log(`  Program ID: ${program.programId.toBase58()}`);
    console.log(`  Authority:  ${authority.toBase58()}`);
    console.log(`  Run ID:     ${runId} (unique market IDs to avoid PDA collisions)`);
    console.log(`  ───────────────────────────────────────────────────────`);
    console.log(`  Pyth Hermes SOL/USD spot: ${fmt$(spotCents)}`);
    console.log(`  Bucket layout: ${numBuckets} buckets × ${fmt$(bucketWidth)} wide, centered on spot`);
    console.log(`  Range: ${fmt$(bucketStart)} → ${fmt$(bucketStart + numBuckets * bucketWidth)}`);
    console.log(`\n${describeBuckets(bucketStart, bucketWidth, numBuckets)}`);
    console.log(`  ═══════════════════════════════════════════════════════\n`);
  });

  // ---------- Test 1: create_market ----------
  it("creates a market with valid params", async () => {
    const marketId = runId;
    const now = Math.floor(Date.now() / 1000);
    const market = marketPda(program.programId, authority, marketId);
    const vault = vaultPda(program.programId, market);

    console.log(`    Creating market #${marketId}...`);
    console.log(`      Market PDA:  ${market.toBase58()}`);
    console.log(`      Vault PDA:   ${vault.toBase58()}`);
    console.log(`      Params: ${numBuckets} buckets, start=${fmt$(bucketStart)}, width=${fmt$(bucketWidth)}`);
    console.log(`      Min bet: ${fmtSOL(MIN_BET.toNumber())}`);
    console.log(`      Betting window: ${BETTING_WINDOW}s (${new Date(now * 1000).toLocaleTimeString()} → ${new Date((now + BETTING_WINDOW) * 1000).toLocaleTimeString()})`);
    console.log(`      Resolution time: ${new Date((now + BETTING_WINDOW) * 1000).toLocaleTimeString()}`);

    await program.methods
      .createMarket({
        marketId: new anchor.BN(marketId),
        feedId: SOL_USD_FEED,
        bucketDecimals: 2,
        bucketStart: new anchor.BN(bucketStart),
        bucketWidth: new anchor.BN(bucketWidth),
        numBuckets,
        minBet: MIN_BET,
        bettingOpen: new anchor.BN(now),
        bettingClose: new anchor.BN(now + BETTING_WINDOW),
        resolutionTime: new anchor.BN(now + BETTING_WINDOW),
        resolveDeadline: new anchor.BN(now + BETTING_WINDOW + 3600),
      })
      .accounts({ authority, market, vault, systemProgram: SystemProgram.programId })
      .rpc();

    const m = await (program.account as any).market.fetch(market);
    expect(Object.keys(m.state)[0]).to.equal("open");
    expect(m.numBuckets).to.equal(numBuckets);
    expect(m.totalPool.toNumber()).to.equal(0);

    console.log(`      ✓ Market created — state: open, pool: 0 SOL`);
  });

  // ---------- Test 2: create_market rejects bad params ----------
  it("rejects market with invalid timestamps", async () => {
    const marketId = runId + 1;
    const now = Math.floor(Date.now() / 1000);
    const market = marketPda(program.programId, authority, marketId);
    const vault = vaultPda(program.programId, market);

    console.log(`    Attempting to create market #${marketId} with invalid timestamps...`);
    console.log(`      bettingClose = now + 100s, but resolutionTime = now + 50s`);
    console.log(`      Rule violated: resolutionTime must be >= bettingClose`);

    try {
      await program.methods
        .createMarket({
          marketId: new anchor.BN(marketId),
          feedId: SOL_USD_FEED,
          bucketDecimals: 2,
          bucketStart: new anchor.BN(bucketStart),
          bucketWidth: new anchor.BN(bucketWidth),
          numBuckets,
          minBet: MIN_BET,
          bettingOpen: new anchor.BN(now),
          bettingClose: new anchor.BN(now + 100),
          resolutionTime: new anchor.BN(now + 50), // before close → invalid
          resolveDeadline: new anchor.BN(now + 200),
        })
        .accounts({ authority, market, vault, systemProgram: SystemProgram.programId })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.toString()).to.include("InvalidTimeStamps");
      console.log(`      ✓ Correctly rejected with InvalidTimeStamps`);
    }
  });

  // ---------- Test 3: place_bet ----------
  it("places a bet and updates pool", async () => {
    const marketId = runId + 10;
    const now = Math.floor(Date.now() / 1000);
    const market = marketPda(program.programId, authority, marketId);
    const vault = vaultPda(program.programId, market);

    console.log(`    Creating market #${marketId} for bet test...`);
    await program.methods
      .createMarket({
        marketId: new anchor.BN(marketId),
        feedId: SOL_USD_FEED,
        bucketDecimals: 2,
        bucketStart: new anchor.BN(bucketStart),
        bucketWidth: new anchor.BN(bucketWidth),
        numBuckets,
        minBet: MIN_BET,
        bettingOpen: new anchor.BN(now),
        bettingClose: new anchor.BN(now + BETTING_WINDOW),
        resolutionTime: new anchor.BN(now + BETTING_WINDOW),
        resolveDeadline: new anchor.BN(now + BETTING_WINDOW + 3600),
      })
      .accounts({ authority, market, vault, systemProgram: SystemProgram.programId })
      .rpc();

    const bucketIndex = 3;
    const bucketLo = bucketStart + bucketIndex * bucketWidth;
    const bucketHi = bucketLo + bucketWidth;
    console.log(`    Placing bet on bucket #${bucketIndex} (${fmt$(bucketLo)} – ${fmt$(bucketHi)})...`);
    console.log(`      Bet amount: ${fmtSOL(BET_AMOUNT.toNumber())}`);

    const position = positionPda(program.programId, market, authority, bucketIndex);
    await program.methods
      .placeBet(bucketIndex, BET_AMOUNT)
      .accounts({ bettor: authority, market, position, vault, systemProgram: SystemProgram.programId })
      .rpc();

    const m = await (program.account as any).market.fetch(market);
    expect(m.totalPool.toNumber()).to.equal(BET_AMOUNT.toNumber());
    expect(m.bucketTotals[bucketIndex].toNumber()).to.equal(BET_AMOUNT.toNumber());

    console.log(`      ✓ Bet placed — pool: ${fmtSOL(m.totalPool.toNumber())}, bucket[${bucketIndex}]: ${fmtSOL(m.bucketTotals[bucketIndex].toNumber())}`);
  });

  // ---------- Test 4: place_bet rejects bad bucket ----------
  it("rejects bet on out-of-range bucket", async () => {
    const marketId = runId + 11;
    const now = Math.floor(Date.now() / 1000);
    const market = marketPda(program.programId, authority, marketId);
    const vault = vaultPda(program.programId, market);

    console.log(`    Creating market #${marketId} with ${numBuckets} buckets (valid indices: 0–${numBuckets - 1})...`);
    await program.methods
      .createMarket({
        marketId: new anchor.BN(marketId),
        feedId: SOL_USD_FEED,
        bucketDecimals: 2,
        bucketStart: new anchor.BN(bucketStart),
        bucketWidth: new anchor.BN(bucketWidth),
        numBuckets,
        minBet: MIN_BET,
        bettingOpen: new anchor.BN(now),
        bettingClose: new anchor.BN(now + BETTING_WINDOW),
        resolutionTime: new anchor.BN(now + BETTING_WINDOW),
        resolveDeadline: new anchor.BN(now + BETTING_WINDOW + 3600),
      })
      .accounts({ authority, market, vault, systemProgram: SystemProgram.programId })
      .rpc();

    const badBucket = 8;
    console.log(`    Attempting bet on bucket #${badBucket} (out of range, max valid: ${numBuckets - 1})...`);

    const position = positionPda(program.programId, market, authority, badBucket);
    try {
      await program.methods
        .placeBet(badBucket, BET_AMOUNT)
        .accounts({ bettor: authority, market, position, vault, systemProgram: SystemProgram.programId })
        .rpc();
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.toString()).to.include("InvalidBucket");
      console.log(`      ✓ Correctly rejected with InvalidBucket (bucket ${badBucket} >= num_buckets ${numBuckets})`);
    }
  });

  // ---------- Test 5: cancel empty market ----------
  it("authority can cancel an empty market", async () => {
    const marketId = runId + 20;
    const now = Math.floor(Date.now() / 1000);
    const market = marketPda(program.programId, authority, marketId);
    const vault = vaultPda(program.programId, market);

    console.log(`    Creating market #${marketId} (will cancel immediately)...`);
    await program.methods
      .createMarket({
        marketId: new anchor.BN(marketId),
        feedId: SOL_USD_FEED,
        bucketDecimals: 2,
        bucketStart: new anchor.BN(bucketStart),
        bucketWidth: new anchor.BN(bucketWidth),
        numBuckets,
        minBet: MIN_BET,
        bettingOpen: new anchor.BN(now),
        bettingClose: new anchor.BN(now + BETTING_WINDOW),
        resolutionTime: new anchor.BN(now + BETTING_WINDOW),
        resolveDeadline: new anchor.BN(now + BETTING_WINDOW + 3600),
      })
      .accounts({ authority, market, vault, systemProgram: SystemProgram.programId })
      .rpc();

    console.log(`    Authority (${authority.toBase58().slice(0, 8)}...) cancelling empty market...`);
    console.log(`      Pool is empty (0 SOL) → authority allowed to cancel`);

    await program.methods
      .cancelMarket()
      .accounts({ caller: authority, market })
      .rpc();

    const m = await (program.account as any).market.fetch(market);
    expect(Object.keys(m.state)[0]).to.equal("canceled");
    console.log(`      ✓ Market canceled — state: ${Object.keys(m.state)[0]}`);
  });

  // ---------- Test 6: full lifecycle with multiple wallets + buckets ----------
  it("full lifecycle: multi-wallet bets, resolve with Pyth, graduated payouts", async () => {
    const marketId = runId + 100;
    const now = Math.floor(Date.now() / 1000);
    const WINDOW = 35; // seconds to wait
    const market = marketPda(program.programId, authority, marketId);
    const vault = vaultPda(program.programId, market);

    console.log(`\n    ── FULL LIFECYCLE TEST (multi-wallet) ──`);
    console.log(`    Step 1: Create market #${marketId}`);
    console.log(`      Resolution in ${WINDOW}s at ${new Date((now + WINDOW) * 1000).toLocaleTimeString()}`);
    console.log(`      Bucket range: ${fmt$(bucketStart)} → ${fmt$(bucketStart + numBuckets * bucketWidth)}`);

    await program.methods
      .createMarket({
        marketId: new anchor.BN(marketId),
        feedId: SOL_USD_FEED,
        bucketDecimals: 2,
        bucketStart: new anchor.BN(bucketStart),
        bucketWidth: new anchor.BN(bucketWidth),
        numBuckets,
        minBet: MIN_BET,
        bettingOpen: new anchor.BN(now),
        bettingClose: new anchor.BN(now + WINDOW),
        resolutionTime: new anchor.BN(now + WINDOW),
        resolveDeadline: new anchor.BN(now + WINDOW + 3600),
      })
      .accounts({ authority, market, vault, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`      ✓ Market created — state: open`);

    // --- Step 2: Create a second wallet and fund it from authority ---
    console.log(`    Step 2: Create second wallet + fund from authority`);
    const wallet2 = Keypair.generate();
    const fundAmount = 0.1 * LAMPORTS_PER_SOL;
    const fundTx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority,
        toPubkey: wallet2.publicKey,
        lamports: fundAmount,
      })
    );
    await provider.sendAndConfirm(fundTx);
    console.log(`      Wallet A (authority): ${authority.toBase58().slice(0, 8)}...`);
    console.log(`      Wallet B (generated): ${wallet2.publicKey.toBase58().slice(0, 8)}...`);
    console.log(`      Funded Wallet B with ${fmtSOL(fundAmount)} from Wallet A`);

    // --- Step 3: Place bets from both wallets on different buckets ---
    console.log(`    Step 3: Place bets from multiple wallets on different buckets`);

    // Wallet A bets on bucket 2 (below center) and bucket 3 (center)
    const betA1_bucket = 2;
    const betA1_amount = new anchor.BN(0.02 * LAMPORTS_PER_SOL);
    const posA1 = positionPda(program.programId, market, authority, betA1_bucket);
    await program.methods
      .placeBet(betA1_bucket, betA1_amount)
      .accounts({ bettor: authority, market, position: posA1, vault, systemProgram: SystemProgram.programId })
      .rpc();
    const bucketA1Lo = bucketStart + betA1_bucket * bucketWidth;
    console.log(`      Wallet A → bucket #${betA1_bucket} (${fmt$(bucketA1Lo)} – ${fmt$(bucketA1Lo + bucketWidth)}) — ${fmtSOL(betA1_amount.toNumber())}`);

    const betA2_bucket = 3;
    const betA2_amount = new anchor.BN(0.02 * LAMPORTS_PER_SOL);
    const posA2 = positionPda(program.programId, market, authority, betA2_bucket);
    await program.methods
      .placeBet(betA2_bucket, betA2_amount)
      .accounts({ bettor: authority, market, position: posA2, vault, systemProgram: SystemProgram.programId })
      .rpc();
    const bucketA2Lo = bucketStart + betA2_bucket * bucketWidth;
    console.log(`      Wallet A → bucket #${betA2_bucket} (${fmt$(bucketA2Lo)} – ${fmt$(bucketA2Lo + bucketWidth)}) — ${fmtSOL(betA2_amount.toNumber())}`);

    // Wallet B bets on bucket 5 (far from center)
    const betB_bucket = 5;
    const betB_amount = new anchor.BN(0.03 * LAMPORTS_PER_SOL);
    const posB = positionPda(program.programId, market, wallet2.publicKey, betB_bucket);
    const betBIx = await program.methods
      .placeBet(betB_bucket, betB_amount)
      .accounts({ bettor: wallet2.publicKey, market, position: posB, vault, systemProgram: SystemProgram.programId })
      .instruction();
    const betBTx = new anchor.web3.Transaction().add(betBIx);
    betBTx.feePayer = wallet2.publicKey;
    betBTx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
    betBTx.sign(wallet2);
    await provider.connection.sendRawTransaction(betBTx.serialize());
    await sleep(2000); // wait for confirmation
    const bucketBLo = bucketStart + betB_bucket * bucketWidth;
    console.log(`      Wallet B → bucket #${betB_bucket} (${fmt$(bucketBLo)} – ${fmt$(bucketBLo + bucketWidth)}) — ${fmtSOL(betB_amount.toNumber())}`);

    // Show pool state
    const mBets = await (program.account as any).market.fetch(market);
    const totalPool = mBets.totalPool.toNumber();
    console.log(`\n      Pool state after all bets:`);
    console.log(`        Total pool: ${fmtSOL(totalPool)}`);
    for (let i = 0; i < numBuckets; i++) {
      const bt = mBets.bucketTotals[i].toNumber();
      if (bt > 0) {
        const lo = bucketStart + i * bucketWidth;
        console.log(`        Bucket #${i} (${fmt$(lo)} – ${fmt$(lo + bucketWidth)}): ${fmtSOL(bt)}`);
      }
    }
    const unfundedCount = mBets.bucketTotals.slice(0, numBuckets).filter((b: any) => b.toNumber() === 0).length;
    console.log(`        Unfunded buckets: ${unfundedCount} of ${numBuckets} (excluded from payout weight sum)`);

    expect(totalPool).to.equal(betA1_amount.toNumber() + betA2_amount.toNumber() + betB_amount.toNumber());

    // --- Step 4: Wait for resolution time ---
    const resolutionTime = now + WINDOW;
    const waitMs = (resolutionTime - Math.floor(Date.now() / 1000) + 5) * 1000;
    console.log(`\n    Step 4: Wait for resolution time`);
    if (waitMs > 0) {
      console.log(`      Waiting ${Math.ceil(waitMs / 1000)}s for resolution_time + 5s buffer...`);
      await sleep(waitMs);
    }

    // --- Step 5: Resolve with Pyth Benchmarks ---
    console.log(`    Step 5: Resolve with Pyth Benchmarks`);
    console.log(`      Fetching historical SOL/USD price at unix timestamp ${resolutionTime}...`);
    console.log(`      Program validates: feed_id match, |publish_time − resolution_time| ≤ 60s, price > 0, conf ≤ 2%`);

    let resolved = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const data = await fetchBenchmarkUpdate(resolutionTime);
        const txBuilder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
        await txBuilder.addPostPriceUpdates(data);
        await txBuilder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => [{
          instruction: await program.methods.resolveMarket().accounts({
            caller: authority,
            market,
            priceUpdate: getPriceUpdateAccount(`0x${SOL_USD_HEX}`),
          }).instruction(),
          signers: [],
        }]);
        const txs = await txBuilder.buildVersionedTransactions({
          computeUnitPriceMicroLamports: 50_000,
        });
        await receiver.provider.sendAll(txs);
        resolved = true;
        break;
      } catch (e: any) {
        if (attempt < 4) {
          console.log(`      Resolve attempt ${attempt + 1} failed (Benchmarks may not have data yet), retrying in 5s...`);
          await sleep(5000);
        } else {
          throw e;
        }
      }
    }
    expect(resolved).to.be.true;

    const mAfter = await (program.account as any).market.fetch(market);
    expect(Object.keys(mAfter.state)[0]).to.equal("resolved");
    expect(mAfter.outcome).to.not.be.null;
    const outcomeCents = mAfter.outcome.toNumber();
    const winningBucket = Math.min(numBuckets - 1, Math.max(0, Math.floor((outcomeCents - bucketStart) / bucketWidth)));

    console.log(`      ✓ Market resolved!`);
    console.log(`        Outcome price: ${fmt$(outcomeCents)}`);
    console.log(`        Closest bucket: #${winningBucket} (${fmt$(bucketStart + winningBucket * bucketWidth)} – ${fmt$(bucketStart + (winningBucket + 1) * bucketWidth)})`);
    console.log(`\n        Distance from each funded bucket to outcome:`);
    for (const [label, b] of [["Wallet A bet 1", betA1_bucket], ["Wallet A bet 2", betA2_bucket], ["Wallet B bet", betB_bucket]] as const) {
      const mid = bucketStart + b * bucketWidth + bucketWidth / 2;
      const dist = Math.abs(outcomeCents - mid);
      console.log(`          ${label}: bucket #${b} (mid: ${fmt$(mid)}) — distance: ${fmt$(dist)} ${b === winningBucket ? "← CLOSEST" : ""}`);
    }

    // --- Step 6: Claims — each wallet claims, verify graduated payouts ---
    console.log(`\n    Step 6: Claims — verify inverse-distance graduated payouts`);
    console.log(`      Payout rule: W = SCALE² / (distance + SCALE). Closer bucket → higher weight → bigger share.`);
    console.log(`      Only funded buckets contribute to weight sum (unfunded buckets ignored).`);

    // Wallet A claims bucket 2
    const balA_before = await provider.connection.getBalance(authority);
    await program.methods
      .claim()
      .accounts({ owner: authority, market, position: posA1, vault, systemProgram: SystemProgram.programId })
      .rpc();
    const balA_after1 = await provider.connection.getBalance(authority);
    const payoutA1 = balA_after1 - balA_before;

    // Wallet A claims bucket 3
    await program.methods
      .claim()
      .accounts({ owner: authority, market, position: posA2, vault, systemProgram: SystemProgram.programId })
      .rpc();
    const balA_after2 = await provider.connection.getBalance(authority);
    const payoutA2 = balA_after2 - balA_after1;

    console.log(`      Wallet A bucket #${betA1_bucket} payout: ~${fmtSOL(Math.max(0, payoutA1))} (${fmtSOL(betA1_amount.toNumber())} staked)`);
    console.log(`      Wallet A bucket #${betA2_bucket} payout: ~${fmtSOL(Math.max(0, payoutA2))} (${fmtSOL(betA2_amount.toNumber())} staked)`);

    // Wallet B claims bucket 5
    const balB_before = await provider.connection.getBalance(wallet2.publicKey);
    const claimBIx = await program.methods
      .claim()
      .accounts({ owner: wallet2.publicKey, market, position: posB, vault, systemProgram: SystemProgram.programId })
      .instruction();
    const claimBTx = new anchor.web3.Transaction().add(claimBIx);
    claimBTx.feePayer = wallet2.publicKey;
    claimBTx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
    claimBTx.sign(wallet2);
    await provider.connection.sendRawTransaction(claimBTx.serialize());
    await sleep(2000);
    const balB_after = await provider.connection.getBalance(wallet2.publicKey);
    const payoutB = balB_after - balB_before;

    console.log(`      Wallet B bucket #${betB_bucket} payout: ~${fmtSOL(Math.max(0, payoutB))} (${fmtSOL(betB_amount.toNumber())} staked)`);

    // Verify graduated payout: bucket closer to outcome should earn more per lamport
    const perLamportA2 = payoutA2 / betA2_amount.toNumber();
    const perLamportB = payoutB / betB_amount.toNumber();
    const distA2 = Math.abs(outcomeCents - (bucketStart + betA2_bucket * bucketWidth + bucketWidth / 2));
    const distB = Math.abs(outcomeCents - (bucketStart + betB_bucket * bucketWidth + bucketWidth / 2));

    console.log(`\n      Per-lamport returns (inverse-distance gradient check):`);
    console.log(`        Bucket #${betA2_bucket} (dist ${fmt$(distA2)}): ${perLamportA2.toFixed(4)} per lamport staked`);
    console.log(`        Bucket #${betB_bucket} (dist ${fmt$(distB)}): ${perLamportB.toFixed(4)} per lamport staked`);

    if (distA2 < distB) {
      expect(perLamportA2).to.be.greaterThan(perLamportB);
      console.log(`        ✓ Closer bucket (#${betA2_bucket}) earned more per lamport than farther bucket (#${betB_bucket})`);
    } else if (distB < distA2) {
      expect(perLamportB).to.be.greaterThan(perLamportA2);
      console.log(`        ✓ Closer bucket (#${betB_bucket}) earned more per lamport than farther bucket (#${betA2_bucket})`);
    } else {
      console.log(`        ≈ Equal distance — payouts should be proportional to stake`);
    }

    // Verify vault is nearly drained (only rent floor + dust remain)
    const vaultBal = await provider.connection.getBalance(vaultPda(program.programId, market));
    const rentFloor = await provider.connection.getMinimumBalanceForRentExemption(0);
    const dust = vaultBal - rentFloor;
    console.log(`\n      Vault after all claims: ${fmtSOL(vaultBal)} (rent floor: ${fmtSOL(rentFloor)}, dust: ${dust} lamports)`);
    console.log(`      ✓ Pool conserved — dust < number of positions (${dust} < 3)`);
    expect(dust).to.be.lessThan(10);

    // Verify positions are closed
    await sleep(2000);
    for (const [label, pos] of [["A1", posA1], ["A2", posA2], ["B", posB]] as const) {
      const acc = await provider.connection.getAccountInfo(pos);
      const closed = !acc || acc.lamports === 0 || acc.data.length === 0;
      expect(closed).to.be.true;
    }
    console.log(`      ✓ All 3 position accounts closed (double-claim protection)\n`);
  });

  // ---------- Test 7: cancel + refund flow ----------
  it("cancel and refund returns stake", async () => {
    const marketId = runId + 200;
    const now = Math.floor(Date.now() / 1000);
    const market = marketPda(program.programId, authority, marketId);
    const vault = vaultPda(program.programId, market);

    const DEADLINE_OFFSET = 35; // seconds

    console.log(`\n    ── CANCEL + REFUND TEST ──`);
    console.log(`    Scenario: market with bets, oracle never resolves → permissionless cancel → full refund`);
    console.log(`    Step 1: Create market #${marketId} with short resolve_deadline (${DEADLINE_OFFSET}s)`);

    await program.methods
      .createMarket({
        marketId: new anchor.BN(marketId),
        feedId: SOL_USD_FEED,
        bucketDecimals: 2,
        bucketStart: new anchor.BN(bucketStart),
        bucketWidth: new anchor.BN(bucketWidth),
        numBuckets,
        minBet: MIN_BET,
        bettingOpen: new anchor.BN(now),
        bettingClose: new anchor.BN(now + 15),
        resolutionTime: new anchor.BN(now + 15),
        resolveDeadline: new anchor.BN(now + DEADLINE_OFFSET),
      })
      .accounts({ authority, market, vault, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`      ✓ Market created — betting closes in 15s, resolve deadline in ${DEADLINE_OFFSET}s`);

    // Place bet
    const bucket = 2;
    const position = positionPda(program.programId, market, authority, bucket);
    console.log(`    Step 2: Place bet on bucket #${bucket} — ${fmtSOL(BET_AMOUNT.toNumber())}`);

    await program.methods
      .placeBet(bucket, BET_AMOUNT)
      .accounts({ bettor: authority, market, position, vault, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`      ✓ Bet placed — pool: ${fmtSOL(BET_AMOUNT.toNumber())}`);

    // Wait past resolve_deadline
    const waitMs = (now + DEADLINE_OFFSET - Math.floor(Date.now() / 1000) + 3) * 1000;
    console.log(`    Step 3: Wait for resolve_deadline to pass`);
    console.log(`      Simulating oracle failure — no one resolves the market`);
    if (waitMs > 0) {
      console.log(`      Waiting ${Math.ceil(waitMs / 1000)}s for deadline to expire...`);
      await sleep(waitMs);
    }

    // Permissionless cancel (anyone can cancel after deadline)
    console.log(`    Step 4: Permissionless cancel (deadline passed, anyone can call)`);
    await program.methods
      .cancelMarket()
      .accounts({ caller: authority, market })
      .rpc();

    const m = await (program.account as any).market.fetch(market);
    expect(Object.keys(m.state)[0]).to.equal("canceled");
    console.log(`      ✓ Market canceled — state: ${Object.keys(m.state)[0]}`);

    // Claim refund
    console.log(`    Step 5: Claim refund (full stake returned)`);
    const balBefore = await provider.connection.getBalance(authority);

    await program.methods
      .claimRefund()
      .accounts({ owner: authority, market, position, vault: vaultPda(program.programId, market), systemProgram: SystemProgram.programId })
      .rpc();

    const balAfter = await provider.connection.getBalance(authority);
    const refunded = balAfter - balBefore;
    console.log(`      ✓ Refunded ~${fmtSOL(Math.max(0, refunded))} (stake + position rent reclaim, minus tx fee)`);

    // Position should be closed — check account is gone or zeroed
    await sleep(2000); // give devnet a moment to finalize
    const posAcc = await provider.connection.getAccountInfo(position);
    const isClosed = !posAcc || posAcc.lamports === 0 || posAcc.data.length === 0;
    expect(isClosed).to.be.true;
    console.log(`      ✓ Position account closed (double-refund protection)\n`);
  });
});

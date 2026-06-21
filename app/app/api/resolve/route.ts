import { NextRequest, NextResponse } from "next/server";
import * as anchor from "@coral-xyz/anchor";
import NodeWallet from "@coral-xyz/anchor/dist/esm/nodewallet";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import idl from "@/lib/idl.json";

const SOL_USD_HEX =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

async function fetchBenchmarkUpdate(unixTs: number): Promise<string[]> {
  // Pyth may not have data at the exact second; search ±30s within program's 60s tolerance
  for (const offset of [0, 1, -1, 2, -2, 5, -5, 10, -10, 20, -20, 30, -30]) {
    const ts = unixTs + offset;
    const url = `https://benchmarks.pyth.network/v1/updates/price/${ts}?ids=0x${SOL_USD_HEX}&encoding=base64`;
    const res = await fetch(url);
    if (res.ok) {
      const json = await res.json();
      return json.binary.data;
    }
    if (res.status !== 404) {
      throw new Error(`Benchmarks ${res.status}: ${await res.text()}`);
    }
  }
  throw new Error(`No Pyth price data within ±30s of timestamp ${unixTs}. Try again in a minute.`);
}

export async function GET(req: NextRequest) {
  try {
    const marketStr = req.nextUrl.searchParams.get("market");
    if (!marketStr)
      return NextResponse.json({ error: "missing market" }, { status: 400 });

    const rpc =
      process.env.NEXT_PUBLIC_RPC ?? "https://api.devnet.solana.com";
    const raw =
      process.env.RESOLVER_KEYPAIR_PATH ??
      `${process.env.HOME}/.config/solana/id.json`;
    const keypairPath = raw.startsWith("~")
      ? raw.replace("~", process.env.HOME!)
      : raw;
    const keypair = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")))
    );

    const connection = new Connection(rpc, "confirmed");
    const wallet = new NodeWallet(keypair);
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    const program = new anchor.Program(idl as anchor.Idl, provider);
    const receiver = new PythSolanaReceiver({ connection, wallet });

    const marketPubkey = new PublicKey(marketStr);
    const m: any = await (program.account as any).market.fetch(marketPubkey);
    const resolutionTime = Number(m.resolutionTime);

    const data = await fetchBenchmarkUpdate(resolutionTime);
    const txBuilder = receiver.newTransactionBuilder({
      closeUpdateAccounts: true,
    });
    await txBuilder.addPostPriceUpdates(data);
    await txBuilder.addPriceConsumerInstructions(
      async (getPriceUpdateAccount) => [
        {
          instruction: await program.methods
            .resolveMarket()
            .accounts({
              caller: wallet.publicKey,
              market: marketPubkey,
              priceUpdate: getPriceUpdateAccount(`0x${SOL_USD_HEX}`),
            })
            .instruction(),
          signers: [],
        },
      ]
    );
    await receiver.provider.sendAll(
      await txBuilder.buildVersionedTransactions({
        computeUnitPriceMicroLamports: 50_000,
      })
    );

    const after: any = await (program.account as any).market.fetch(
      marketPubkey
    );
    return NextResponse.json({ outcome: after.outcome.toNumber() });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

"use client";

import {
  useAnchorWallet,
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import { SystemProgram, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MARKET, vaultPda, positionPda, fmt$, fmtSOL } from "@/lib/program";
import idl from "@/lib/idl.json";

const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (m) => m.WalletMultiButton
    ),
  { ssr: false }
);

const SOL = 1_000_000_000;
const SCALE = 1_000_000_000;

function useProgram() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  return useMemo(() => {
    if (!wallet) return null;
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
      skipPreflight: true,
    });
    return new anchor.Program(idl as anchor.Idl, provider);
  }, [connection, wallet]);
}

type UserPosition = { bucket: number; amount: number };

function weight(distance: number, bucketWidth: number): number {
  const dn = (distance * SCALE) / bucketWidth;
  return (SCALE * SCALE) / (dn + SCALE);
}

function estimatePayout(
  amount: number,
  bucketTotal: number,
  w: number,
  sumWeights: number,
  totalPool: number
): number {
  if (bucketTotal === 0 || sumWeights === 0) return 0;
  const s1 = (amount * totalPool) / bucketTotal;
  return (s1 * w) / sumWeights;
}

function formatTime(seconds: number): string {
  if (seconds <= 0) return "0s";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function Home() {
  const program = useProgram();
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [m, setM] = useState<any>(null);
  const [bucket, setBucket] = useState(3);
  const [amount, setAmount] = useState("0.05");
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState<{
    msg: string;
    type: "ok" | "err" | "info";
  } | null>(null);
  const [positions, setPositions] = useState<UserPosition[]>([]);
  const [positionTick, setPositionTick] = useState(0);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const numBucketsRef = useRef<number>(0);

  const poll = useCallback(() => {
    if (!program) return;
    (program.account as any).market
      .fetch(MARKET)
      .then((data: any) => {
        const firstLoad = numBucketsRef.current === 0;
        numBucketsRef.current = data.numBuckets as number;
        setM(data);
        if (firstLoad) setPositionTick((t) => t + 1);
      })
      .catch((e: any) =>
        setStatus({ msg: `Failed to load market: ${e.message}`, type: "err" })
      );
  }, [program]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 10000);
    return () => clearInterval(id);
  }, [poll]);

  // 1s tick for countdown timer
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);

  // Refresh positions less frequently
  useEffect(() => {
    const id = setInterval(() => setPositionTick((t) => t + 1), 15000);
    return () => clearInterval(id);
  }, []);

  // Fetch user positions on a separate, slower interval
  useEffect(() => {
    if (!program || !publicKey || numBucketsRef.current === 0) return;
    const n = numBucketsRef.current;
    Promise.all(
      Array.from({ length: n }, (_, i) => {
        const pda = positionPda(program.programId, MARKET, publicKey, i);
        return (program.account as any).position
          .fetch(pda)
          .then((p: any) => ({
            bucket: i,
            amount: (p.amount as anchor.BN).toNumber(),
          }))
          .catch(() => null);
      })
    ).then((results) =>
      setPositions(results.filter((p): p is UserPosition => p !== null && p.amount > 0))
    );
  }, [program, publicKey, positionTick]);

  // Compute weights for payout estimation (must be before early return)
  const payoutInfo = useMemo(() => {
    if (!m) return null;
    const outcome = m.outcome ? (m.outcome as anchor.BN).toNumber() : null;
    if (outcome === null) return null;
    const pool = (m.totalPool as anchor.BN).toNumber();
    if (pool === 0) return null;
    const n = m.numBuckets as number;
    const bw = (m.bucketWidth as anchor.BN).toNumber();
    const start = (m.bucketStart as anchor.BN).toNumber();
    const totals = (m.bucketTotals as anchor.BN[]).slice(0, n).map((b) => b.toNumber());
    const lo = start + bw / 2;
    const hi = start + (n - 1) * bw + bw / 2;
    const x = Math.max(lo, Math.min(hi, outcome));
    const weights: number[] = [];
    let sw = 0;
    for (let i = 0; i < n; i++) {
      const mid = start + i * bw + bw / 2;
      const w = weight(Math.abs(mid - x), bw);
      weights.push(w);
      if (totals[i] > 0) sw += w;
    }
    return { weights, sumWeights: sw, clampedOutcome: x };
  }, [m]);

  if (!m) {
    return (
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
          fontFamily: "var(--font-sans)",
        }}
      >
        <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em" }}>
          Bucketier
        </div>
        <div style={{ color: "var(--text-dim)", fontSize: 14 }}>
          {!program
            ? "Connect your wallet to get started"
            : "Loading market data..."}
        </div>
        <WalletMultiButton />
        {status && (
          <div style={{ color: "var(--red)", fontSize: 13, maxWidth: 400, textAlign: "center" }}>
            {status.msg}
          </div>
        )}
      </main>
    );
  }

  const n = m.numBuckets as number;
  const totals = (m.bucketTotals as anchor.BN[])
    .slice(0, n)
    .map((b) => b.toNumber());
  const max = Math.max(...totals, 1);
  const bw = (m.bucketWidth as anchor.BN).toNumber();
  const start = (m.bucketStart as anchor.BN).toNumber();
  const state = Object.keys(m.state)[0];
  const outcome = m.outcome ? (m.outcome as anchor.BN).toNumber() : null;
  const closeTs = (m.bettingClose as anchor.BN).toNumber();
  const resTs = (m.resolutionTime as anchor.BN).toNumber();
  const deadlineTs = (m.resolveDeadline as anchor.BN).toNumber();
  const pool = (m.totalPool as anchor.BN).toNumber();
  const sumWeights = m.sumWeights
    ? (m.sumWeights as anchor.BN).toNumber()
    : null;
  const vault = vaultPda(program!.programId, MARKET);

  const bettingOpen = state === "open" && now < closeTs;
  const canResolve = state === "open" && now >= resTs;
  const canCancel = state === "open" && now > deadlineTs;
  const secondsLeft = Math.max(0, Math.floor(closeTs - now));

  const totalUserBet = positions.reduce((s, p) => s + p.amount, 0);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setStatus(null);
    try {
      await fn();
      poll();
      setPositionTick((t) => t + 1);
    } catch (e: any) {
      setStatus({ msg: e.message ?? String(e), type: "err" });
    } finally {
      setBusy("");
    }
  };

  const placeBet = () =>
    act("bet", async () => {
      const position = positionPda(
        program!.programId,
        MARKET,
        publicKey!,
        bucket
      );
      const ix = await program!.methods
        .placeBet(bucket, new anchor.BN(Number(amount) * SOL))
        .accounts({
          bettor: publicKey!,
          market: MARKET,
          position,
          vault,
          system_program: SystemProgram.programId,
        })
        .instruction();

      const tx = new anchor.web3.Transaction().add(ix);
      tx.feePayer = publicKey!;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

      const sig = await sendTransaction(tx, connection, {
        skipPreflight: true,
      });
      await connection.confirmTransaction(sig, "confirmed");
      setStatus({ msg: `Bet placed on bucket #${bucket}!`, type: "ok" });
    });

  const resolve = () =>
    act("resolve", async () => {
      setStatus({ msg: "Resolving via Pyth oracle...", type: "info" });
      const res = await fetch(`/api/resolve?market=${MARKET.toBase58()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setStatus({
        msg: `Market resolved at ${fmt$(body.outcome)}`,
        type: "ok",
      });
    });

  const claim = (b: number) =>
    act(`claim${b}`, async () => {
      const position = positionPda(program!.programId, MARKET, publicKey!, b);
      await program!.methods
        .claim()
        .accounts({
          owner: publicKey!,
          market: MARKET,
          position,
          vault,
          system_program: SystemProgram.programId,
        })
        .rpc();
      setStatus({ msg: `Claimed payout for bucket #${b}!`, type: "ok" });
    });

  const claimRefund = (b: number) =>
    act(`refund${b}`, async () => {
      const position = positionPda(program!.programId, MARKET, publicKey!, b);
      await program!.methods
        .claimRefund()
        .accounts({
          owner: publicKey!,
          market: MARKET,
          position,
          vault,
          system_program: SystemProgram.programId,
        })
        .rpc();
      setStatus({ msg: `Refunded bucket #${b}!`, type: "ok" });
    });

  const cancelMarket = () =>
    act("cancel", async () => {
      await program!.methods
        .cancelMarket()
        .accounts({ caller: publicKey!, market: MARKET })
        .rpc();
      setStatus({ msg: "Market canceled.", type: "ok" });
    });

  // Find winning bucket index
  const winBucket =
    outcome !== null
      ? totals.findIndex((_, i) => {
          const lo = start + i * bw;
          return outcome >= lo && outcome < lo + bw;
        })
      : -1;

  return (
    <main
      style={{
        maxWidth: 820,
        margin: "0 auto",
        padding: "24px 20px 60px",
        fontFamily: "var(--font-sans)",
        animation: "fade-in 0.3s ease-out",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 32,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span
            style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.03em" }}
          >
            Bucketier
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            SOL/USD
          </span>
        </div>
        <WalletMultiButton />
      </div>

      {/* Market Status Bar */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 1,
          background: "var(--border)",
          borderRadius: 12,
          overflow: "hidden",
          marginBottom: 28,
        }}
      >
        <StatCell
          label="Status"
          value={state.toUpperCase()}
          color={
            state === "open"
              ? "var(--green)"
              : state === "resolved"
                ? "var(--accent)"
                : "var(--red)"
          }
          pulse={state === "open"}
        />
        <StatCell
          label="Total pool"
          value={`${fmtSOL(pool)} SOL`}
          mono
        />
        {bettingOpen && (
          <StatCell
            label="Closes in"
            value={formatTime(secondsLeft)}
            color={secondsLeft < 60 ? "var(--red)" : "var(--text)"}
          />
        )}
        {outcome !== null && (
          <StatCell
            label="Resolution price"
            value={fmt$(outcome)}
            color="var(--amber)"
            mono
          />
        )}
        {!bettingOpen && state === "open" && !canResolve && (
          <StatCell
            label="Resolves at"
            value={new Date(resTs * 1000).toLocaleTimeString()}
          />
        )}
      </div>

      {/* Bucket Chart */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: "20px 16px 12px",
          marginBottom: 20,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 16,
            fontSize: 12,
            color: "var(--text-dim)",
          }}
        >
          <span>Price distribution</span>
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {fmt$(start)} — {fmt$(start + n * bw)}
          </span>
        </div>

        {/* Bars */}
        <div
          style={{
            display: "flex",
            gap: 3,
            alignItems: "flex-end",
            height: 160,
            marginBottom: 6,
          }}
        >
          {totals.map((t, i) => {
            const lo = start + i * bw;
            const mid = lo + bw / 2;
            const isWin = i === winBucket;
            const isSelected = i === bucket && bettingOpen;
            const userPos = positions.find((p) => p.bucket === i);
            const barH = Math.max(4, (t / max) * 130);
            const userH = userPos
              ? Math.max(2, (userPos.amount / max) * 130)
              : 0;

            return (
              <div
                key={i}
                onClick={() => bettingOpen && setBucket(i)}
                style={{
                  flex: 1,
                  cursor: bettingOpen ? "pointer" : "default",
                  textAlign: "center",
                  position: "relative",
                }}
              >
                {t > 0 && (
                  <div
                    style={{
                      fontSize: 10,
                      marginBottom: 3,
                      color: "var(--text-dim)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {fmtSOL(t)}
                  </div>
                )}
                <div style={{ position: "relative", height: barH }}>
                  <div
                    style={{
                      position: "absolute",
                      bottom: 0,
                      left: 0,
                      right: 0,
                      height: barH,
                      background: isWin
                        ? "var(--green)"
                        : isSelected
                          ? "var(--accent)"
                          : t > 0
                            ? "var(--surface-2)"
                            : "var(--border)",
                      borderRadius: 3,
                      border: isSelected
                        ? "1.5px solid var(--accent)"
                        : isWin
                          ? "1.5px solid var(--green)"
                          : "1px solid transparent",
                      transition: "all 0.2s ease",
                    }}
                  />
                  {/* User position overlay */}
                  {userH > 0 && (
                    <div
                      style={{
                        position: "absolute",
                        bottom: 0,
                        left: "15%",
                        right: "15%",
                        height: userH,
                        background: isWin
                          ? "rgba(16, 185, 129, 0.6)"
                          : "rgba(59, 130, 246, 0.5)",
                        borderRadius: 2,
                        border: `1px solid ${isWin ? "var(--green)" : "var(--accent)"}`,
                      }}
                    />
                  )}
                </div>
                {/* Outcome marker */}
                {isWin && outcome !== null && (
                  <div
                    style={{
                      position: "absolute",
                      bottom: barH + 18,
                      left: "50%",
                      transform: "translateX(-50%)",
                      fontSize: 9,
                      color: "var(--green)",
                      fontWeight: 700,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {fmt$(outcome)}
                  </div>
                )}
                <div
                  style={{
                    fontSize: 11,
                    marginTop: 6,
                    color:
                      isSelected || isWin
                        ? "var(--text)"
                        : "var(--text-dim)",
                    fontFamily: "var(--font-mono)",
                    fontWeight: isSelected || isWin ? 600 : 400,
                  }}
                >
                  {fmt$(mid)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* User Positions */}
      {positions.length > 0 && publicKey && (
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 16,
            marginBottom: 20,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              Your positions
            </span>
            <span
              style={{
                fontSize: 12,
                color: "var(--text-dim)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {fmtSOL(totalUserBet)} SOL total
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {positions.map((p) => {
              const lo = start + p.bucket * bw;
              const mid = lo + bw / 2;
              const isWin = p.bucket === winBucket;
              const pct =
                totals[p.bucket] > 0
                  ? ((p.amount / totals[p.bucket]) * 100).toFixed(1)
                  : "0";
              let estPayout = 0;
              if (payoutInfo && payoutInfo.sumWeights > 0) {
                estPayout = estimatePayout(
                  p.amount,
                  totals[p.bucket],
                  payoutInfo.weights[p.bucket],
                  payoutInfo.sumWeights,
                  pool
                );
              }
              return (
                <div
                  key={p.bucket}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 1fr auto auto",
                    gap: 12,
                    alignItems: "center",
                    padding: "8px 10px",
                    borderRadius: 8,
                    background: isWin ? "var(--green-dim)" : "var(--surface-2)",
                    border: isWin
                      ? "1px solid var(--green)"
                      : "1px solid transparent",
                    fontSize: 13,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontWeight: 600,
                      color: isWin ? "var(--green)" : "var(--text)",
                      minWidth: 60,
                    }}
                  >
                    {fmt$(mid)}
                  </span>
                  <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                    {pct}% of bucket
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--text)",
                    }}
                  >
                    {fmtSOL(p.amount)} SOL
                  </span>
                  {state === "resolved" && payoutInfo && (
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        color: estPayout > p.amount ? "var(--green)" : "var(--amber)",
                        fontWeight: 600,
                        fontSize: 12,
                      }}
                    >
                      {estPayout > 0
                        ? `+${fmtSOL(estPayout)} SOL`
                        : "—"}
                    </span>
                  )}
                  {state === "resolved" && (
                    <button
                      disabled={!!busy}
                      onClick={() => claim(p.bucket)}
                      style={{
                        background: "var(--green)",
                        color: "#fff",
                        border: "none",
                        borderRadius: 6,
                        padding: "4px 10px",
                        cursor: busy ? "wait" : "pointer",
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      {busy === `claim${p.bucket}` ? "..." : "Claim"}
                    </button>
                  )}
                  {state === "canceled" && (
                    <button
                      disabled={!!busy}
                      onClick={() => claimRefund(p.bucket)}
                      style={{
                        background: "var(--amber)",
                        color: "#000",
                        border: "none",
                        borderRadius: 6,
                        padding: "4px 10px",
                        cursor: busy ? "wait" : "pointer",
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      {busy === `refund${p.bucket}` ? "..." : "Refund"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Bet Panel */}
      {bettingOpen && publicKey && (
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            padding: 16,
            marginBottom: 20,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600 }}>Place bet</span>
            <span
              style={{
                fontSize: 12,
                color: "var(--accent)",
                fontFamily: "var(--font-mono)",
              }}
            >
              Bucket #{bucket} · {fmt$(start + bucket * bw)} –{" "}
              {fmt$(start + (bucket + 1) * bw)}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "0 10px",
                flex: 1,
                maxWidth: 200,
              }}
            >
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 0",
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: "var(--text)",
                  fontSize: 15,
                  fontFamily: "var(--font-mono)",
                }}
              />
              <span
                style={{
                  color: "var(--text-dim)",
                  fontSize: 12,
                  fontWeight: 600,
                  marginLeft: 6,
                }}
              >
                SOL
              </span>
            </div>
            <button
              disabled={!!busy}
              onClick={placeBet}
              style={{
                background: "var(--accent)",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "9px 24px",
                cursor: busy ? "wait" : "pointer",
                fontSize: 14,
                fontWeight: 600,
                transition: "background 0.15s",
                opacity: busy ? 0.7 : 1,
              }}
              onMouseEnter={(e) =>
                !busy &&
                ((e.target as HTMLElement).style.background =
                  "var(--accent-hover)")
              }
              onMouseLeave={(e) =>
                ((e.target as HTMLElement).style.background = "var(--accent)")
              }
            >
              {busy === "bet" ? "Sending..." : "Place bet"}
            </button>
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              marginTop: 8,
            }}
          >
            Click a bucket in the chart to select your price range
          </div>
        </div>
      )}

      {/* Resolve */}
      {canResolve && publicKey && (
        <button
          disabled={!!busy}
          onClick={resolve}
          style={{
            background: "var(--green)",
            color: "#fff",
            border: "none",
            borderRadius: 10,
            padding: "12px 20px",
            cursor: busy ? "wait" : "pointer",
            fontSize: 14,
            fontWeight: 600,
            marginBottom: 20,
            width: "100%",
            opacity: busy ? 0.7 : 1,
            transition: "opacity 0.15s",
          }}
        >
          {busy === "resolve"
            ? "Resolving with Pyth oracle..."
            : "Resolve market"}
        </button>
      )}

      {/* Cancel */}
      {canCancel && publicKey && (
        <button
          disabled={!!busy}
          onClick={cancelMarket}
          style={{
            background: "var(--red-dim)",
            color: "var(--red)",
            border: "1px solid var(--red)",
            borderRadius: 10,
            padding: "12px 20px",
            cursor: busy ? "wait" : "pointer",
            fontSize: 14,
            fontWeight: 600,
            marginBottom: 20,
            width: "100%",
          }}
        >
          {busy === "cancel"
            ? "Canceling..."
            : "Cancel market (deadline passed)"}
        </button>
      )}

      {/* Status */}
      {status && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            background:
              status.type === "ok"
                ? "var(--green-dim)"
                : status.type === "info"
                  ? "var(--surface-2)"
                  : "var(--red-dim)",
            border: `1px solid ${
              status.type === "ok"
                ? "var(--green)"
                : status.type === "info"
                  ? "var(--border)"
                  : "var(--red)"
            }`,
            color:
              status.type === "ok"
                ? "var(--green)"
                : status.type === "info"
                  ? "var(--text)"
                  : "var(--red)",
            fontSize: 13,
            marginBottom: 20,
            animation: "fade-in 0.2s ease-out",
          }}
        >
          {status.msg}
        </div>
      )}

      {/* Market Details Footer */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 1,
          background: "var(--border)",
          borderRadius: 10,
          overflow: "hidden",
          fontSize: 12,
          marginTop: 12,
        }}
      >
        <div
          style={{
            background: "var(--surface)",
            padding: "10px 14px",
          }}
        >
          <div style={{ color: "var(--text-muted)", marginBottom: 2 }}>
            Market
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
            {MARKET.toBase58().slice(0, 20)}...
          </div>
        </div>
        <div
          style={{
            background: "var(--surface)",
            padding: "10px 14px",
          }}
        >
          <div style={{ color: "var(--text-muted)", marginBottom: 2 }}>
            Resolution time
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
            {new Date(resTs * 1000).toLocaleString()}
          </div>
        </div>
        <div
          style={{
            background: "var(--surface)",
            padding: "10px 14px",
          }}
        >
          <div style={{ color: "var(--text-muted)", marginBottom: 2 }}>
            Payout model
          </div>
          <div style={{ fontSize: 11 }}>
            Parimutuel · inverse-distance weighted
          </div>
        </div>
        <div
          style={{
            background: "var(--surface)",
            padding: "10px 14px",
          }}
        >
          <div style={{ color: "var(--text-muted)", marginBottom: 2 }}>
            Oracle
          </div>
          <div style={{ fontSize: 11 }}>Pyth Network SOL/USD</div>
        </div>
      </div>

      {/* Branding */}
      <div
        style={{
          textAlign: "center",
          fontSize: 11,
          color: "var(--text-muted)",
          marginTop: 24,
        }}
      >
        Parimutuel scalar prediction markets on Solana
      </div>
    </main>
  );
}

function StatCell({
  label,
  value,
  color,
  mono,
  pulse,
}: {
  label: string;
  value: string;
  color?: string;
  mono?: boolean;
  pulse?: boolean;
}) {
  return (
    <div style={{ background: "var(--surface)", padding: "12px 16px" }}>
      <div
        style={{
          fontSize: 11,
          color: "var(--text-muted)",
          marginBottom: 3,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: color ?? "var(--text)",
          fontFamily: mono ? "var(--font-mono)" : "inherit",
          animation: pulse ? "pulse-glow 2s ease-in-out infinite" : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}

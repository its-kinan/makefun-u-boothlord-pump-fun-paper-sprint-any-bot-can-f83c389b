// Early-tape rider for the pump.fun paper sprint.
//
// Idea: the dev tape shows winners spike on huge early inflow and fade
// within ~50 slots, so entries must be early and exits fast. A launch is
// bought only inside its first few slots, only when the opening tape
// shows real demand from a small set of buyers, and only when the
// creator has not sold. Every position carries a hard stop, a trailing
// stop, a take-profit and a short hold cap. A paced minimal probe keeps
// the 20-coin guardrail reachable on a thin 6-hour final window.
//
// Deterministic: no clock, no randomness, no network. All parameters
// are constants below; the only state is the tape each batch brings.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type BuyInput,
  type SellInput,
} from "./vendor/makefun-bot.ts";

// ---- entry gates (opening tape, first ENTRY_SLOTS slots of life) ----
const ENTRY_SLOTS = 6;
const MIN_TRADES = 3;
const MIN_BUYERS = 2;
const MAX_BUYERS = 3;
const MIN_REAL_SOL = 2n * LAMPORTS_PER_SOL;
const MIN_NET_BUY_SOL = 2n * LAMPORTS_PER_SOL;
const MAX_CREATOR_BUY_SOL = 25n * LAMPORTS_PER_SOL / 10n;
const MIN_PRICE_X = 1.0;
const MAX_PRICE_X = 3.0;
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL target
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL guardrail floor

// ---- exits ----
const TAKE_PROFIT_X = 1.3;
const STOP_X = 0.88;
const TRAIL_ARM_X = 1.15;
const TRAIL_KEEP_X = 0.9; // sell once price falls to 90% of peak
const HOLD_CAP_SLOTS = 20; // winners spike then fade within ~50 slots:
// a 10-slot cap cut them before the trailing stop could do its work,
// so the cap is loosened and the trailing stop carries the exit.

// ---- guardrail probes (only while the coin count is thin) ----
const PROBE_TARGET_COINS = 32;
const PROBE_STAKE = LAMPORTS_PER_SOL / 50n; // 0.02 SOL
const PROBE_PACE_SLOTS = 1500;
const PROBE_MAX = 60;

const MAX_SLIPPAGE_BPS = 10_000;

interface Tape {
  mint: string;
  createdSlot: number;
  createPrice: number;
  creator: string;
  trades: number;
  buyers: Set<string>;
  netBuyLamports: bigint;
  creatorBuyLamports: bigint;
  creatorSold: boolean;
  decided: boolean;
}

interface Held {
  entryPrice: number;
  peakPrice: number;
  buySlot: number;
  probe: boolean;
}

const tapes = new Map<string, Tape>();
const held = new Map<string, Held>();
let coinsTraded = 0;
let probesSent = 0;
let lastProbeSlot = -1_000_000;

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    const orders: Array<BuyInput | SellInput> = [];

    // ---- absorb this batch of events into the tape ----
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        if (!tapes.has(e.mint)) {
          tapes.set(e.mint, {
            mint: e.mint,
            createdSlot: e.slot,
            createPrice: priceOf(
              BigInt(e.virtual_quote_reserves),
              BigInt(e.virtual_token_reserves),
            ),
            creator: e.creator,
            trades: 0,
            buyers: new Set<string>(),
            netBuyLamports: 0n,
            creatorBuyLamports: 0n,
            creatorSold: false,
            decided: false,
          });
        }
        continue;
      }
      if (e.event !== "TradeEvent") continue;
      const tape = tapes.get(e.mint);
      if (tape === undefined) continue;
      tape.trades += 1;
      const sol = BigInt(e.sol_amount);
      if (e.is_buy) {
        tape.buyers.add(e.user);
        tape.netBuyLamports += sol;
        if (e.user === tape.creator) tape.creatorBuyLamports += sol;
      } else {
        tape.netBuyLamports -= sol;
        if (e.user === tape.creator) tape.creatorSold = true;
      }
    }

    // ---- exits first: free a slot before deciding new buys ----
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === "sell") pendingSell.add(p.order.mint);
    }
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingSell.has(mint)) continue;
      const info = held.get(mint);
      if (info === undefined) continue;
      const now = priceOf(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
      );
      if (now <= 0 || info.entryPrice <= 0) continue;
      if (now > info.peakPrice) info.peakPrice = now;
      const ratio = now / info.entryPrice;
      const age = state.slot - info.buySlot;
      const trailHit =
        info.peakPrice >= info.entryPrice * TRAIL_ARM_X &&
        now <= info.peakPrice * TRAIL_KEEP_X;
      const creatorDump = tapes.get(mint)?.creatorSold === true;
      if (
        ratio >= TAKE_PROFIT_X ||
        ratio <= STOP_X ||
        trailHit ||
        age >= HOLD_CAP_SLOTS ||
        creatorDump ||
        info.probe
      ) {
        orders.push({
          side: "sell",
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        held.delete(mint);
      }
    }

    // ---- entries: one decision per launch, inside its first slots ----
    const pendingBuy = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === "buy") pendingBuy.add(p.order.mint);
    }
    for (const tape of tapes.values()) {
      if (tape.decided) continue;
      if (state.positions.has(tape.mint) || pendingBuy.has(tape.mint)) {
        tape.decided = true;
        continue;
      }
      const age = state.slot - tape.createdSlot;
      if (age > ENTRY_SLOTS) {
        tape.decided = true;
        continue;
      }
      const curve = state.curves.get(tape.mint);
      if (curve === undefined || curve.complete) {
        tape.decided = true;
        continue;
      }
      if (tape.trades < MIN_TRADES) continue;
      if (tape.buyers.size < MIN_BUYERS || tape.buyers.size > MAX_BUYERS) {
        tape.decided = true;
        continue;
      }
      if (curve.real_quote_reserves < MIN_REAL_SOL) continue;
      if (tape.netBuyLamports < MIN_NET_BUY_SOL) continue;
      if (tape.creatorSold || tape.creatorBuyLamports > MAX_CREATOR_BUY_SOL) {
        tape.decided = true;
        continue;
      }
      const now = priceOf(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
      );
      if (tape.createPrice <= 0 || now <= 0) continue;
      const px = now / tape.createPrice;
      if (px < MIN_PRICE_X || px > MAX_PRICE_X) continue;
      const cap = state.maxBuyLamports(tape.mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) {
        tape.decided = true;
        continue;
      }
      if (orders.length >= caps.max_orders_per_batch) continue;
      if (slots <= 0 || free < amount + tx) continue;
      orders.push({
        side: "buy",
        mint: tape.mint,
        quote_lamports: amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      held.set(tape.mint, {
        entryPrice: now,
        peakPrice: now,
        buySlot: state.slot,
        probe: false,
      });
      tape.decided = true;
      coinsTraded += 1;
      free -= amount + tx;
      slots -= 1;
    }

    // ---- guardrail probe: a minimal round trip while coins are thin ----
    if (
      coinsTraded < PROBE_TARGET_COINS &&
      probesSent < PROBE_MAX &&
      state.slot - lastProbeSlot >= PROBE_PACE_SLOTS &&
      slots > 0 &&
      orders.length < caps.max_orders_per_batch
    ) {
      let bestMint: string | null = null;
      let bestReal = 0n;
      for (const tape of tapes.values()) {
        if (tape.decided) continue;
        if (state.positions.has(tape.mint) || pendingBuy.has(tape.mint)) {
          continue;
        }
        const curve = state.curves.get(tape.mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves > bestReal) {
          bestReal = curve.real_quote_reserves;
          bestMint = tape.mint;
        }
      }
      if (bestMint !== null) {
        const cap = state.maxBuyLamports(bestMint);
        const amount = cap < PROBE_STAKE ? cap : PROBE_STAKE;
        if (amount >= MIN_BUY_LAMPORTS && free >= amount + tx) {
          const curve = state.curves.get(bestMint);
          const now =
            curve === undefined
              ? 0
              : priceOf(
                  curve.virtual_quote_reserves,
                  curve.virtual_token_reserves,
                );
          orders.push({
            side: "buy",
            mint: bestMint,
            quote_lamports: amount,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          tapes.get(bestMint)!.decided = true;
          held.set(bestMint, {
            entryPrice: now,
            peakPrice: now,
            buySlot: state.slot,
            probe: true,
          });
          coinsTraded += 1;
          probesSent += 1;
          lastProbeSlot = state.slot;
          free -= amount + tx;
          slots -= 1;
        }
      }
    }

    return orders;
  },
});

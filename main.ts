// Mean-reversion BTC trading bot for make.fun bounty
// btc-race-24h-20261123-0511 — "Race a BTC trading bot live for 24 hours".
//
// Variant B — MEAN REVERSION: fade short-term extremes (Bollinger Band +
// RSI), tight stops, small size, quick exits. LONG ONLY (the protocol sets
// caps.shorts = false; no shorting, no leverage). A trend filter blocks
// counter-trend entries in strong trends, with an extreme-oversold
// override for crash bottoms.
//
// Why aggregated bars: 1-minute closes are mostly noise — a lower-band
// touch on 1m bars fires constantly and the next-open fill eats the bounce.
// The bot aggregates incoming 1m bars into 5-minute bars (bucketed by bar
// time, so a missing minute just shortens one bucket) and takes signals off
// those (BB 20x5m at 1.5σ, RSI 14x5m). Stops are still checked on every 1m bar so a
// sharp move cannot run past the stop inside an aggregation window.
//
// Protocol: agent-fun/bars-replay/v1, spoken through the kit's TypeScript
// SDK shim (vendored byte-for-byte under vendor/, per the kit's
// instructions). One reply per batch, echoing its seq. Fills land at the
// next bar's open (4 bps fee + 2 bps slippage + pool impact); the batch
// after a fill reports it, and the entry price is taken from the reported
// fill, never assumed. Position state is read from the account each batch
// carries, never from the bot's own bookkeeping alone.
//
// Determinism: pure function of the hello + batch stream. No randomness,
// no wall clock, no network, no files, no set/map-order dependence.
// Node 22, erasable TypeScript only, standard library only.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// ---------------------------------------------------------------- parameters
const AGG_MINUTES = 5; // aggregate incoming 1m bars into N-minute bars
const BB_PERIOD = 20; // Bollinger window (in aggregated bars)
const BB_MULT = 1.5; // Bollinger width in standard deviations (1.5σ:
// 2σ fires only once a day on the dev window; 1.5σ catches real dips
// while 1.0σ overtrades — swept on 4 windows, 1.5σ had the best
// worst-window PnL)
const RSI_PERIOD = 14; // RSI window (in aggregated bars)
const RSI_OVERSOLD = 30; // enter long only at/below this RSI
const RSI_EXTREME = 22; // extreme oversold: may enter even in a strong downtrend
const SMA_TREND = 30; // trend-filter SMA window (in aggregated bars)
const TREND_MAX_DIP = 0.985; // block entries when close < SMA * this (strong downtrend)
const ATR_PERIOD = 14; // ATR window (in aggregated bars)
const RISK_FRACTION = 0.3; // max fraction of equity committed per trade
const RISK_BUDGET = 0.015; // max equity fraction risked to the stop (1.5%)
const STOP_ATR = 2.0; // stop distance in ATRs below entry
const TP_MIN_PCT = 0.008; // minimum take-profit (0.8%) before mean target counts
const TRAIL_TRIGGER_PCT = 0.005; // once up this much, trail the stop to entry + 0.2%
const TRAIL_LOCK_PCT = 0.002;
const MAX_HOLD_BARS = 48; // time exit in aggregated bars (48 x 5m = 4h)
const COOLDOWN_BARS = 2; // aggregated bars to wait after any exit
const WARMUP_BARS = 40; // aggregated bars before any trading
const MAX_SLIPPAGE_BPS = 200; // reject protection: fill >2% from latest close

function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function std(xs: number[], m: number): number {
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}

interface AggBar {
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Mean-reversion state. All prices are floats in USDC. */
class Strategy {
  private readonly priceScale: number;
  private closes: number[] = []; // one per completed aggregated bar
  private highs: number[] = [];
  private lows: number[] = [];
  private bucket: number | null = null;
  private agg: AggBar = { o: 0, h: 0, l: 0, c: 0 };
  private aggN = 0;
  private aggIndex = 0;
  private entryPrice = 0; // fill price of the open position (0 = flat)
  private entryAgg = 0;
  private trailStop = 0; // 0 = not yet armed
  private cooldownUntil = 0;

  constructor(priceScale: number) {
    this.priceScale = priceScale;
  }

  private price(raw: string): number {
    return Number(BigInt(raw)) / 10 ** this.priceScale;
  }

  private bollinger(): [number, number, number] {
    const w = this.closes.slice(-BB_PERIOD);
    const m = mean(w);
    const s = std(w, m);
    return [m, m - BB_MULT * s, m + BB_MULT * s];
  }

  private rsi(): number {
    const w = this.closes.slice(-(RSI_PERIOD + 1));
    let gains = 0;
    let losses = 0;
    for (let i = 1; i < w.length; i++) {
      const d = w[i] - w[i - 1];
      if (d > 0) gains += d;
      else losses -= d;
    }
    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - 100 / (1 + rs);
  }

  private atr(): number {
    const n = Math.min(ATR_PERIOD, this.closes.length - 1);
    if (n <= 0) return 0;
    let total = 0;
    for (let i = this.closes.length - n; i < this.closes.length; i++) {
      const prev = this.closes[i - 1];
      total += Math.max(this.highs[i] - this.lows[i], Math.abs(this.highs[i] - prev), Math.abs(this.lows[i] - prev));
    }
    return total / n;
  }

  private sma(period: number): number {
    return mean(this.closes.slice(-period));
  }

  private closePosition(state: BarsState): OrderInput | null {
    const held = state.positions.get(SYMBOL);
    if (held === undefined || held.qty <= 0n) return null;
    // Entry tracking is cleared only when the sell FILL arrives
    // (applyFills): if this order is rejected we stay in the position
    // and must keep managing it.
    return { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
  }

  private finishAggBar(): void {
    this.closes.push(this.agg.c);
    this.highs.push(this.agg.h);
    this.lows.push(this.agg.l);
    this.aggIndex += 1;
    this.aggN = 0; // prevents a second finish when the next bucket starts
  }

  /** Fold this batch's fills into entry tracking. A buy fill sets the
   * entry price (the fill's price, in USDC); a sell fill clears it and
   * starts the cooldown. Rejected fills change nothing. */
  applyFills(batch: Batch): void {
    for (const f of batch.fills) {
      if (f.symbol !== SYMBOL || f.status !== 'filled') continue;
      if (f.side === 'buy') {
        this.entryPrice = this.price(f.price);
        this.entryAgg = this.aggIndex;
        this.trailStop = 0;
      } else if (f.side === 'sell') {
        this.entryPrice = 0;
        this.trailStop = 0;
        this.cooldownUntil = this.aggIndex + COOLDOWN_BARS;
      }
    }
  }

  /** One 1m bar in; an order, or null. Called once per batch that
   * carries a CBBTC bar (batches without the symbol: no signal). */
  decide(state: BarsState, bar: { t: number; o: string; h: string; l: string; c: string }): OrderInput | null {
    const o = this.price(bar.o);
    const h = this.price(bar.h);
    const l = this.price(bar.l);
    const c = this.price(bar.c);
    const bucket = Math.floor(bar.t / (AGG_MINUTES * 60 * 1000));

    // Accumulate into the current aggregated bar.
    if (this.bucket === null || bucket !== this.bucket) {
      if (this.bucket !== null && this.aggN > 0) this.finishAggBar();
      this.bucket = bucket;
      this.agg = { o, h, l, c };
      this.aggN = 0;
    } else {
      this.agg.h = Math.max(this.agg.h, h);
      this.agg.l = Math.min(this.agg.l, l);
    }
    this.agg.c = c;
    this.aggN += 1;

    // A bar just closed only when this 1m bar completes the bucket.
    // (Buckets are aligned to UTC 5-minute boundaries; a missing minute
    // shortens a bucket but never delays the signal past the bucket's
    // last present minute.)
    const barClosed = Math.floor((bar.t + 60 * 1000) / (AGG_MINUTES * 60 * 1000)) !== bucket;
    const held = state.positions.get(SYMBOL);
    const holding = held !== undefined && held.qty > 0n;

    // Intra-window stop: checked on every 1m bar so a sharp move cannot
    // run past the stop inside an aggregation window.
    if (holding && this.entryPrice > 0 && this.closes.length > 0) {
      const atr = this.atr();
      if (atr > 0 && c <= this.entryPrice - STOP_ATR * atr) {
        return this.closePosition(state);
      }
    }

    if (!barClosed) return null;
    this.finishAggBar();

    if (this.aggIndex <= WARMUP_BARS || state.warmingUp) return null;

    const [_smaMid, lower, upper] = this.bollinger();
    const rsi = this.rsi();
    const atr = this.atr();
    const smaTrend = this.sma(SMA_TREND);

    // --- manage an open position ---------------------------------------
    if (holding && this.entryPrice > 0) {
      const stop = this.entryPrice - STOP_ATR * atr;
      const tp = this.entryPrice * (1 + TP_MIN_PCT);
      // Mean-reversion target: the upper half of the band. Let winners
      // run past the middle band; a trailing stop locks in part of the
      // move once price is up 0.5%.
      const meanTarget = Math.max(upper, tp);
      if (this.trailStop === 0 && c >= this.entryPrice * (1 + TRAIL_TRIGGER_PCT)) {
        this.trailStop = this.entryPrice * (1 + TRAIL_LOCK_PCT);
      }
      const heldBars = this.aggIndex - this.entryAgg;
      if (
        c <= stop ||
        (this.trailStop > 0 && c <= this.trailStop) ||
        c >= meanTarget ||
        heldBars >= MAX_HOLD_BARS
      ) {
        return this.closePosition(state);
      }
      return null;
    }

    // --- flat: look for an oversold fade -------------------------------
    if (this.aggIndex < this.cooldownUntil) return null;

    // Bounce confirmation: do not catch a still-falling knife — the
    // aggregated bar must close above the previous one's close.
    const bounced = this.closes.length >= 2 && c > this.closes[this.closes.length - 2];

    // Trend filter: do not fade into a strong downtrend, UNLESS the
    // sell-off is extreme (RSI <= RSI_EXTREME) — a crash bottom is
    // exactly where mean reversion pays, and the filter would block the
    // best entries of the day.
    const inDowntrend = c < smaTrend * TREND_MAX_DIP;
    if (inDowntrend && rsi > RSI_EXTREME) return null;

    if (c <= lower && rsi <= RSI_OVERSOLD && bounced && atr > 0) {
      const equityUsd = Number(state.equity) / 1_000_000;
      const cashUsd = Number(state.cash) / 1_000_000;
      // Size: 30% of equity, risk-capped so a stop-out costs at most
      // 1.5% of equity. Also never spend more cash than held (sells in
      // the same reply never fund a buy).
      let notional = Math.min(RISK_FRACTION * equityUsd, cashUsd);
      const riskNotional = (RISK_BUDGET * equityUsd * c) / (STOP_ATR * atr);
      notional = Math.min(notional, riskNotional);
      // Price impact: keep the trade small enough that impact at the
      // latest close's depth stays under ~10 bps.
      const impact = state.impactBps(SYMBOL, BigInt(Math.floor(notional * 1_000_000)));
      if (impact !== null && impact > 10n) {
        notional = (notional * 10) / Number(impact);
      }
      const units = Math.floor(notional * 1_000_000);
      if (units < 1_000_000) return null; // below the 1 USDC minimum notional
      return { side: 'buy', symbol: SYMBOL, notional_quote_units: units, max_slippage_bps: MAX_SLIPPAGE_BPS };
    }
    return null;
  }
}

let strategy: Strategy | null = null;

await runBars({
  onHello(state) {
    const sym = state.symbols.get(SYMBOL);
    if (sym === undefined) throw new Error(`symbol ${SYMBOL} not in hello`);
    strategy = new Strategy(sym.price_scale);
  },
  onBatch(state, batch) {
    if (strategy === null) throw new Error('batch before hello');
    strategy.applyFills(batch);
    const orders: OrderInput[] = [];
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      const order = strategy.decide(state, bar);
      if (order !== null) orders.push(order);
    }
    return orders;
  },
});

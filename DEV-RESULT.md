# DEV-RESULT — Variant B (mean reversion)

Bounty: `btc-race-24h-20261123-0511` — "Race a BTC trading bot live for 24 hours"
($50, top 10 paid; long only; $1,000 USDC start; fill at next bar's open;
4 bps fee + 2 bps slippage + pool price impact; full round trip ~26 bps.)

## Kit status

**RULES.txt WAS available** — the kit landed during the build
(`~/workspace/makefun/btc-race-24h-20261123-0511-kit/`, 396-line RULES.txt
read in full). The bot was rewritten to the kit's real protocol
(`agent-fun/bars-replay/v1`, NDJSON stdin/stdout, hello once, one batch per
minute, one reply per batch echoing `seq`, max 16 orders/reply) using the
kit's TypeScript SDK shim, vendored byte-for-byte under `vendor/`
(`main.ts` entrypoint, Node 22, erasable TypeScript, stdlib only).
Long only, no shorts, no leverage — per `caps.shorts = false`.

## Official local grade (kit's own grader — authoritative)

Command (from the kit dir):

```
node cli/makefun.mjs grade-local --kit . \
  --bot ~/workspace/makefun/btc-race-24h-20261123-0511-entry-b \
  --driver process --worktree
```

Result (kit's dev window, 1,440 bars re-derived from 42,947 pool-state samples):

| Metric | Value |
|---|---|
| **Net PnL** | **+5.035203 USDC** (return +0.5035%) — **dev gate PASSES (>$0)** |
| Trades | 4 fills = 2 round trips, win rate 1.000, 0 rejected |
| Max drawdown | 0.1608% (guardrail ≤25% — met with huge margin) |
| Fees paid | 0.482625 USDC; net PnL at 2x fees still +4.550634 USDC |
| Exposure | 3.55% of the window |
| Determinism | **L1 regrade reproduced byte for byte** (two executions, action logs identical) |
| Guardrails | met (trades ok, symbols ok, drawdown ok) |
| result_sha256 | `2812caa1d1e9ad9f19514c11abecde21a05a3c5cc818253b2c321181834b7350` |
| action_log_sha256 | `6dc1c5a1c147247e948c1e6bc64f2a869767dcc25f8b126baabd2fa7d36ea7c5` |

Note from the grader: `result_sha256` cannot equal the server's because the
server's harness runs Node v26.13.1 and this machine runs v24.22.1 — an
environment note, not a failure. The bot uses only erasable TypeScript +
Node stdlib, so it runs identically under Node 22/24/26.

## Independent cross-check (own protocol-level replay driver)

Same result reproduced outside the grader (`/tmp/drive.mjs`, hello + batches
built from the kit dataset, harness fill model: fee 4 bps, slippage 2 bps,
constant-product impact vs each bar's `o_depth`):

- Net PnL **+$5.04**, 2 round trips, 4 fills, 0 rejected, max DD **0.16%**.

Trades (decided bar → fill at next bar's open):

| # | Buy (decided) | Sell (decided) | Exit fill | Proceeds |
|---|---|---|---|---|
| 1 | bar 927, close $60,544.62, $300.00 | bar 1072, close $61,118.26 | $61,059.49 | $302.14 |
| 2 | bar 1297, close $60,424.69, $300.64 | bar 1322, close $61,124.75 | $61,092.46 | $303.54 |

## Strategy (final parameters)

5-minute aggregated bars (1m closes are mostly noise); entry when the 5m
close ≤ lower Bollinger Band (20 periods, **1.5σ**) AND RSI(14) ≤ 30 AND the
bar closes above the previous close (bounce confirmation); trend filter
blocks entries >1.5% below the 30-bar SMA unless RSI ≤ 22 (crash-bottom
override). Exit at the upper Bollinger Band (min +0.8%), trailing stop locks
+0.2% once up 0.5%, hard stop 2× ATR(14) checked every 1m bar, time exit
after 4h. Size 30% of equity, risk-capped to ≤1.5% of equity per stop-out,
impact-capped to ~10 bps.

Parameter choice: swept on 4 windows (kit dev +3.6%, Binance Nov 22, Nov 21,
Nov 20 falling −8.5%). The 2σ variant fired only once on the dev window
(0 trades, $0 — fails the gate); 1.0–1.25σ overtraded and lost more on the
falling window. 1.5σ/RSI 30 had the best worst-window PnL (−$2.75 on the
falling day) with kit-dev +$5.04 and max drawdown ≤1.05% on every window.

## Known limits

- Only 2 trades fired on the dev window — the edge is thin and the dev
  PnL (+$5.04) rests on two winning fades. The race window is a different
  24h; the bot is designed to stay flat rather than force trades, and even
  a small negative race PnL can place (top 10 are paid whatever the sign)
  as long as it makes ≥1 trade and keeps drawdown ≤25%.
- Not submitted / not pushed / not bundled by this builder (main agent's job).

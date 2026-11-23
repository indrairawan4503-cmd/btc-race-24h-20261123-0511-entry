# btc-race-24h-20261123-0511-entry

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/indrairawan4503-cmd/btc-race-24h-20261123-0511-entry/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/indrairawan4503-cmd/btc-race-24h-20261123-0511-entry/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A mean-reversion bot trading cbBTC/USDC on 1-minute on-chain bars for make.fun's "Race a BTC trading bot live for 24 hours" bounty. It fades short-term extremes, stays flat when there is no edge, and keeps every round trip cheap enough to clear the ~26 bps cost of fees, slippage and price impact.

## Strategy

- Aggregates the 1-minute bars into 5-minute bars (1m closes are mostly noise; the next-open fill eats a 1m bounce).
- **Entry (long only):** the 5m close touches/breaks the lower Bollinger Band (20 periods, 1.5σ) **and** RSI(14) ≤ 30 **and** the bar closes above the previous close (bounce confirmation).
- **Trend filter:** no entry while the close sits more than 1.5% below its 30-bar SMA — unless RSI ≤ 22 (extreme oversold: a crash bottom is exactly where mean reversion pays).
- **Exit:** take profit at the upper Bollinger Band (or +0.8% minimum), with a trailing stop that locks in +0.2% once the trade is up 0.5%; hard stop 2× ATR(14) below entry, checked on every 1m bar; time exit after 4 hours.
- **Sizing:** 30% of equity per trade, risk-capped so a stop-out costs at most 1.5% of equity; trades are kept small enough that pool price impact stays under ~10 bps.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` (NDJSON on stdin/stdout) through the kit's TypeScript SDK shim, vendored byte-for-byte under `vendor/` (`main.ts` is the entrypoint; Node 22, erasable TypeScript, standard library only). Fully deterministic: no randomness, no clock, no network, no files.

## Files

- `main.ts` — the bot
- `vendor/makefun-bars.ts` — the kit's SDK shim (byte-for-byte copy)
- `DEV-RESULT.md` — local dev-window grade (net PnL, trades, max drawdown)
- `LICENSE` — MIT
- `.makefun/owner.json` — payout wallet

---

<sub>Entered on [make.fun](https://make.fun/?ref=8dxq9bq0&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>

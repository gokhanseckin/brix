# brix.money — wiTRY / iTRY dashboard

A static dashboard that reconstructs the on-chain history of brix.money's iTRY
ERC-20 and the wiTRY ERC-4626 staking vault on Ethereum mainnet, charts the
key indicators, and computes a 7-day APY in both lira and dollars.

Everything is built from public Ethereum data (Etherscan v2 API) plus the
ECB's daily TRY/USD reference rate (Frankfurter) — no protocol-side
dependencies, no API keys other than Etherscan, no build step.

The repo ships **two pages** off the same dataset:

- **`/`** (live, [brix-tau.vercel.app](https://brix-tau.vercel.app)) — ECB
  TRY/USD via Frankfurter. The stable, business-day reference variant.
- **`/staging`** ([brix-tau.vercel.app/staging](https://brix-tau.vercel.app/staging))
  — same data, but USD figures are repriced through RedStone's on-chain
  TRY/USD oracle on MegaETH. Adds a "TRY/USD on-chain" chart that overlays
  individual `ValueUpdate` events with the UTC-day mean used for repricing,
  plus a live `latestAnswer()` spot read off the canonical TRY price-feed
  proxy.

![dashboard preview](https://placehold.co/800x60/0b0d11/8b93a1?text=APY+TRY+•+APY+USD+•+wiTRY+supply+•+iTRY+supply+•+iTRY+TVL+•+Unwrapped+iTRY)

## Quick start

Requires Node ≥ 20.

```bash
git clone https://github.com/gokhanseckin/brix.git
cd brix
cp .env.example .env
# paste your Etherscan API key (https://etherscan.io/apis) into .env

npm run fetch     # builds web/snapshots.json from on-chain history
npm run serve     # serves ./web on http://localhost:3000
```

First fetch takes a couple of minutes; reruns are seconds because event logs
and FX rates are cached under `data/` and re-pulled incrementally.

To deploy on a fresh Linux box (e.g. a Hetzner VPS), the repo also ships a
one-shot bootstrap:

```bash
curl -fsSL https://raw.githubusercontent.com/gokhanseckin/brix/main/bootstrap.sh \
  | ETHERSCAN_API_KEY=YOURKEY bash
```

It installs Node 20, clones the repo, runs the fetch and serves on `:8080`.

## What the dashboard shows

### Hero indicators

A two-row strip at the top with six headline numbers:

| Indicator | What it is | How it's computed |
|---|---|---|
| **APY 7d · TRY** | Vault yield over the trailing 7 days, annualised, in lira terms | `(price_now / price_7d_ago) ^ (365/7) − 1` where `price = wiTRY share price × NAV` (TRY/iTRY). Captures the protocol's intrinsic yield — independent of FX moves. |
| **APY 7d · USD** | Same window, what a USD-based holder actually earned | Same formula, but `price = wiTRY share price × NAV × ECB TRY/USD daily rate`. Combines vault yield with the TRY/USD FX move; flips negative when the lira depreciates faster than the vault accrues. |
| **wiTRY supply** | Number of wiTRY shares outstanding | `wiTRY.totalSupply()`, reconstructed from `Transfer` mints minus burns. Same number brix.money's homepage labels "wiTRY". |
| **iTRY supply** | All iTRY tokens currently in circulation | `iTRY.totalSupply()`, reconstructed from `Transfer` mints minus burns. |
| **iTRY locked / TVL** | iTRY currently held inside the wiTRY vault contract | `iTRY.balanceOf(wiTRY)`, reconstructed from `Transfer` events with the vault as sender or recipient. This is the actual value secured by the protocol — the standard meaning of "TVL" for an ERC-4626 vault. |
| **Unwrapped iTRY** | iTRY sitting in user wallets (i.e. not in the vault) | `iTRY.totalSupply() − iTRY.balanceOf(wiTRY)`. Strict on-chain ledger view. (Note: brix.money's homepage shows a slightly different number — see [Unwrapped iTRY accounting](#unwrapped-itry-accounting) below.) |

### Charts

1. **wiTRY share value** — left axis is `iTRY per share` (= `totalAssets / totalSupply`), right axis is `USD per share` (= left × NAV × FX). The iTRY line shows the vault's intrinsic yield; the USD line shows the lira-aware return.
2. **iTRY supply & TVL (TRY)** — three series in lira:
   - `iTRY Supply` — total iTRY × NAV
   - `iTRY TVL` — iTRY locked in vault × NAV
   - `wiTRY supply/shares` — share count (dashed)
3. **iTRY supply & TVL (USD)** — same three series repriced through the ECB daily TRY/USD rate.

The horizontal axis starts at `2026-03-23` by default (the Monday before the
first user deposits) so the early NAV-feed deploy days don't pad the left
edge. Override with `CHART_START_DATE=YYYY-MM-DD npm run fetch`.

## Concepts in detail

### Share price (`1 wiTRY = X iTRY`)

ERC-4626 vaults issue **shares** (wiTRY) in exchange for the underlying
**asset** (iTRY). The exchange rate at any point in time is:

```
share_price = totalAssets / totalSupply
            = iTRY locked in vault / wiTRY shares outstanding
```

It starts at 1.0 and rises as the vault accrues yield (the Yield Forwarder
mints fresh iTRY directly into the vault on each NAV update). A holder
redeems wiTRY for `share_price × wiTRY_amount` iTRY.

### NAV

A simple price oracle (`0xa5b6f7404D960BaC4075EcAEc31E37B940c2A145`)
publishing the lira value of one iTRY via `setPrice(uint256)`. Currently
fixed at `1.0 TRY` per iTRY (the protocol's peg). The contract emits no
event on update, so this dashboard mines NAV history from `txlist` calls to
the contract instead of from logs.

### TVL ("Total Value Locked")

For a single-asset vault like wiTRY, TVL is the **balance of the underlying
asset** held by the vault contract — i.e. `iTRY.balanceOf(wiTRY)` ≈ 199 M
iTRY. It's *not* the same as the total iTRY supply (some iTRY is held in
user wallets, the OFT adapter, the iTRY silo, etc.) and *not* the same as
wiTRY share count (the share count lags TVL by exactly the share-price
premium).

### Unwrapped iTRY accounting

Brix.money's homepage shows "Unwrapped iTRY" as `total iTRY − wiTRY share
count` (≈ 27.6 M). That's a deliberate accounting view that treats every
share as "1 iTRY of principal at peg time", and gives a tidy identity:

```
total iTRY  =  wiTRY shares  +  unwrapped iTRY
```

This dashboard uses the **strict ledger** instead — `total iTRY − iTRY in
vault` (≈ 22.0 M) — because that's the actual iTRY token count sitting in
user wallets right now. The 5.6 M gap between the two figures equals the
vault's accrued yield since launch (i.e. the cumulative share-price
premium).

### APY methodology

Standard trailing-window vault APY:

```
APY = (price_now / price_7d_ago) ^ (365 / window_days) − 1
```

Where `price` is the wiTRY share price expressed in the relevant unit
(TRY for the vault-yield reading, USD for the holder return). Computed
from the daily snapshot series, so it requires the chart to span at least
8 days.

### Why two APYs

iTRY is pegged to the Turkish lira. The vault's intrinsic yield is the
lira yield brix delivers (≈ 35-40 % annualised — in line with Turkey's
policy rate environment). For a USD-based holder, the realised return
also includes the **lira's depreciation against the dollar**, which the
TRY/USD FX rate captures. Showing both makes the trade-off explicit:

```
USD APY  ≈  TRY APY  −  TRY/USD depreciation rate
```

## Data sources

| Source | What we use it for |
|---|---|
| **Etherscan v2 API** (`api.etherscan.io`) | iTRY/wiTRY `Transfer` logs, NAV-feed `setPrice` txs, contract creation blocks, ABI lookup, `decimals()` reads. Also used as a multichain endpoint (`chainid=4326`) to ingest RedStone TRY `ValueUpdate` events on MegaETH for `/staging`. Free tier (5 rps) is sufficient — steady-state ≈ 300 calls/day, dominated by the MegaETH scan. |
| **Frankfurter** (`api.frankfurter.dev`) | Daily TRY/USD reference rates (ECB) — drives the `/` (home) page and is the fallback on `/staging` for days RedStone hasn't covered yet. Free, no API key. Forward-filled across weekends/holidays. Override with `TRY_USD=<rate>` env for offline runs. |
| **RedStone on-chain (MegaETH)** | TRY/USD pricing for `/staging`. We page `ValueUpdate(uint256 value, bytes32 dataFeedId, uint256 updatedAt)` events from the multi-feed adapter `0x57677Bdc4F24D5c08ddCE87E06670C26a00Cac0b`, filter to the TRY data feed, and average per UTC day. We also `eth_call latestAnswer()` on the dedicated TRY price-feed proxy `0x1b0FDa12D125B864756Bbf191ad20eaB10915a6F` for the live spot rate. |
| **Chart.js + chartjs-adapter-date-fns** (CDN) | Rendering only. Loaded directly from jsDelivr in the static page. |

No protocol-side endpoints (no brix.money API), no other oracles.

## Method (how the daily snapshots are built)

Etherscan does **not** expose historical `eth_call`, so per-day balances
are reconstructed entirely from event logs and transactions:

| Quantity | Derivation |
|---|---|
| iTRY total supply | iTRY `Transfer` mints (`from = 0x0`) minus burns (`to = 0x0`) |
| iTRY held by wiTRY (vault TVL) | iTRY `Transfer` events with the wiTRY contract as sender/recipient |
| wiTRY total supply | wiTRY `Transfer` mints minus burns |
| NAV value | Last `setPrice(uint256)` tx to the NAV feed at/before each day |
| TRY/USD (home `/`) | ECB business-day rate for each day (forward-filled on weekends) |
| TRY/USD (`/staging`) | Arithmetic mean of every RedStone `ValueUpdate` for the TRY feed in that UTC day on MegaETH; falls back to the ECB rate on days with no on-chain TRY events. The `/staging` script overrides `data.usdPerTry` client-side from `data.redstone.dailyAvgUsdPerTry` and recomputes every USD-derived series and the 7-day USD APY. |

All events are merged into a single `(blockNumber, logIndex)`-sorted stream
and replayed once. At each UTC-midnight boundary the running counters are
written into a daily snapshot. The chart is then derived from these
snapshots; days with no event keep the previous values, except wiTRY share
price which is `null` while no shares exist.

## Layout

```
scripts/fetch-data.mjs    Etherscan ingest, FX fetch, RedStone scan, daily replay
web/index.html            Home page (ECB-priced USD)
web/staging/index.html    Staging page (RedStone-priced USD + on-chain TRY chart)
web/snapshots.json        Generated artifact (committed only as needed)
bootstrap.sh              One-shot install + run for fresh Linux boxes
data/                     Cached event logs and FX rates (gitignored), incl.
                          logs-redstone-try-megaeth.json for the TRY feed
```

The fetch script is a single Node module with zero runtime dependencies
(implements its own keccak-256 inline so it can compute event topics and
function selectors without pulling in `ethers`/`viem`).

## Contracts (Ethereum mainnet)

| Contract | Address |
|---|---|
| iTRY token (ERC-20) | `0xb492B4aFD9658093694CF9452D5C272e8230F3B0` |
| iTRY Issuer | `0x9a40DCE442013e6664C308016206DA4BA2a9e824` |
| Fast Access Vault | `0x62f131F9CdeA7B4af5770F8Abe2286D3922c2f8f` |
| NAV Feed | `0xa5b6f7404D960BaC4075EcAEc31E37B940c2A145` |
| Yield Forwarder | `0xfBd72e2D942507BADBA06D2AC80AeE94b4F7f817` |
| iTRY OFT Adapter | `0xa21819cb613c9525e31178812b665933471E5e88` |
| iTRY Silo | `0x1b301c8182eE7C519577d4acF15587fE539197DF` |
| wiTRY (ERC-4626) | `0xE346C29b5B60Ef870b9724c57ccfbBc631e47DEE` |
| wiTRY Vault Composer | `0x638C914ecDB6adabEfa0F8cfDcC228D367069e59` |
| wiTRY OFT Adapter | `0x698b7518711bDe4832fDc19F5262DF705c713006` |

Only the iTRY token, the wiTRY vault, and the NAV feed are read by this
dashboard. The other addresses are listed for reference.

## Contracts (MegaETH, used by `/staging`)

| Contract | Address |
|---|---|
| RedStone multi-feed adapter (`MegaEthReferenceMultiFeedAdapterWithoutRoundsV1`, emits `ValueUpdate(value, dataFeedId, updatedAt)` for ~12 feeds incl. TRY) | `0x57677Bdc4F24D5c08ddCE87E06670C26a00Cac0b` |
| RedStone TRY price-feed proxy (Chainlink `AggregatorV3Interface`; `description() == "RedStone Price Feed for TRY"`; reads delegate into the multi-feed adapter) | `0x1b0FDa12D125B864756Bbf191ad20eaB10915a6F` |

TRY data feed id (bytes32, ASCII `"TRY"` right-padded):
`0x5452590000000000000000000000000000000000000000000000000000000000`. Decimals: 8.
The TRY feed first appears on the multi-feed adapter at block 15,109,340
(2026-05-04 14:52 UTC); earlier blocks emit `ValueUpdate` for other feeds
only, which is why `/staging`'s on-chain chart starts on 2026-05-04 even
though the rest of the dashboard goes back further. (We checked: the same
multi-feed adapter is deployed on MegaETH testnet `chain 6343` but has
zero `ValueUpdate` events ever, so there's no older history to backfill
from.)

## Configuration env vars

| Var | Default | Purpose |
|---|---|---|
| `ETHERSCAN_API_KEY` | — (required) | Etherscan v2 API key. The same key works for chain 1 (Ethereum, used by `/`) and chain 4326 (MegaETH, used by `/staging`). |
| `CHART_START_DATE` | `2026-03-23` | First day on the X axis (`YYYY-MM-DD`) |
| `TRY_USD` | — | If set, use this flat TRY/USD rate instead of fetching daily ECB rates (useful for offline runs). Bypasses Frankfurter; does not affect the RedStone scan. |
| `NAV_DECIMALS` | discovered, falls back to 18 | Override for the NAV feed's decimal precision |
| `REDSTONE_FROM_BLOCK` | `15100000` | First MegaETH block the RedStone TRY scan considers. The default sits just before the first TRY `ValueUpdate` (block 15,109,340). Lower values waste calls; higher values truncate history. |
| `REDSTONE_BLOCK_WINDOW` | `20000` | Initial block window per Etherscan v2 `getLogs` page. Halves on cap-hit / query-timeout, grows on sparse pages — usually self-tunes. |
| `REDSTONE_BUCKET_SECS` | `300` | Bucket size (seconds) for the per-update samples emitted to `snapshots.json` (`redstone.tryUsdSamples`). One median price per bucket — keeps the JSON small while preserving intra-day shape on the chart. |

## Deploy

The dashboard is a static site under `web/`, deployed on Vercel and
auto-refreshed daily by GitHub Actions.

1. **GitHub side** — add a repo secret `ETHERSCAN_API_KEY` at
   `Settings → Secrets and variables → Actions`. The workflow at
   `.github/workflows/refresh-snapshots.yml` runs every day at 06:00 UTC
   (after the ECB FX publication), regenerates `web/snapshots.json`, and
   commits it back to `main`. Block/log caches under `data/` are persisted
   between runs via `actions/cache`, so reruns are incremental and finish
   in seconds.

2. **Vercel side** — import the repo at https://vercel.com/new. Vercel
   reads `vercel.json` (`outputDirectory: web`, no build step) and serves
   `web/` as a static site. No environment variables are needed on Vercel:
   the data is committed by the Action, and each push to `main` triggers
   an automatic redeploy. `snapshots.json` is served with a short edge TTL
   (`s-maxage=300, stale-while-revalidate=86400`) and `index.html` with
   `no-cache` so the new data appears immediately after each refresh.

`ETHERSCAN_API_KEY` only needs to live as a GitHub repo secret. Vercel
never fetches on-chain data directly.

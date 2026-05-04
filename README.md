# brix.money — wiTRY / iTRY history charts

Two daily-resolution charts derived from on-chain history of brix.money's iTRY
ERC-20 and the wiTRY ERC-4626 staking vault on Ethereum mainnet:

1. **wiTRY value vs. time** — value of one wiTRY share, expressed in iTRY (the
   share price `totalAssets / totalSupply`) and in USDC (share price × NAV).
2. **TVL vs. time** — total value locked of wiTRY and iTRY (both in USDC).

The valuation reference is the protocol's own NAV oracle.

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

## Run

Requires Node ≥ 20.

```bash
cp .env.example .env
# paste an Etherscan API key (https://etherscan.io/apis) into .env
npm run fetch        # builds web/snapshots.json from on-chain logs
npm run serve        # serves ./web on http://localhost:3000
# or just open web/index.html directly in a browser
```

The fetch step caches block lookups and event logs under `data/`, so reruns
incrementally pick up only new days.

## Method

Etherscan does not expose historical `eth_call`, so daily snapshots are
reconstructed entirely from event logs:

| Quantity | Derivation |
|---|---|
| iTRY total supply | iTRY `Transfer` mints (`from = 0x0`) minus burns (`to = 0x0`) |
| iTRY held by wiTRY (= wiTRY `totalAssets`) | iTRY `Transfer` to/from the wiTRY address |
| wiTRY total supply | wiTRY `Transfer` mints minus burns |
| NAV (USD per iTRY) | Latest NAV-feed update event at/before end of day |

A daily UTC-midnight block index (`getblocknobytime`) buckets events into days.
Forward-fill is applied for days with no NAV update.

## Layout

```
scripts/fetch-data.mjs    Etherscan ingest + daily replay
web/index.html            Chart.js renderer (loads snapshots.json)
web/snapshots.json        Generated artifact
data/                     Cached blocks/logs (gitignored)
```

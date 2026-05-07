#!/usr/bin/env node
// Fetch Ethereum event history for brix.money's iTRY + wiTRY contracts via the
// Etherscan v2 API and reconstruct daily snapshots of share price and TVL.
//
// Run with `npm run fetch` after setting ETHERSCAN_API_KEY in .env.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const WEB_DIR = resolve(ROOT, "web");

// ---------- Contracts ----------------------------------------------------

const ITRY = "0xb492B4aFD9658093694CF9452D5C272e8230F3B0";
const WITRY = "0xE346C29b5B60Ef870b9724c57ccfbBc631e47DEE";
const NAV_FEED = "0xa5b6f7404D960BaC4075EcAEc31E37B940c2A145";

const ZERO = "0x0000000000000000000000000000000000000000";

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ---------- RedStone TRY/USD on-chain feed (MegaETH) ---------------------
//
// MegaEthReferenceMultiFeedAdapterWithoutRoundsV1 (proxy at REDSTONE_FEED)
// emits ValueUpdate(uint256 value, bytes32 dataFeedId, uint256 updatedAt)
// for several assets including TRY. All event params are NON-indexed, so
// we cannot pre-filter by feedId via topics — fetch all ValueUpdate logs
// for the contract and decode in JS. We hit Etherscan v2's multichain
// endpoint (it supports chain 4326 = MegaETH on the existing API key)
// instead of public Blockscout, which rate-limits aggressive paging.
const REDSTONE_CHAIN_ID = 4326;
const REDSTONE_FEED = "0x57677Bdc4F24D5c08ddCE87E06670C26a00Cac0b";
// Dedicated TRY price-feed proxy on MegaETH — implements the Chainlink
// AggregatorV3Interface (`latestAnswer`, `latestRoundData`, `decimals`).
// It has no events / update txs of its own; reads delegate into the
// multi-feed adapter at REDSTONE_FEED. Useful for (a) the live "now"
// spot rate (one cheap `eth_call`) and (b) canonical attribution in the
// UI. Description is "RedStone Price Feed for TRY".
const REDSTONE_TRY_AGGREGATOR = "0x1b0FDa12D125B864756Bbf191ad20eaB10915a6F";
// keccak256("ValueUpdate(uint256,bytes32,uint256)")
const VALUE_UPDATE_TOPIC =
  "0xf36866d965ee70c8632ff558f5cf8d41ee9ca1d0d0bc7700786e57be60747390";
const TRY_FEED_ID =
  "0x5452590000000000000000000000000000000000000000000000000000000000";
const REDSTONE_DECIMALS = 8;
// Multi-feed adapter creation block on MegaETH is 2,732,522. The TRY data
// feed itself only became active in the adapter recently (around block
// ~15,100,000, ≈ 2026-04-30) — earlier blocks emit many ValueUpdate logs
// for other feeds (BNB/BTC/ETH/SOL/USDC/USDT/MEGA/etc.) but no TRY rows,
// so paging the full multi-million-event history just to find a few
// hundred TRY events is wasteful. We start ingestion at the first block
// where TRY appears in this adapter. Older days on the chart fall back
// to the ECB rate already in `data.usdPerTry`. Override with
// REDSTONE_FROM_BLOCK if you need older history.
const REDSTONE_FEED_START_BLOCK = parseInt(
  process.env.REDSTONE_FROM_BLOCK || "15100000",
  10,
);

// ---------- .env loader (no dotenv dependency) ---------------------------

function loadEnv() {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// ---------- Keccak-256 (Ethereum, pad delimiter 0x01) --------------------

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];
const MASK = 0xffffffffffffffffn;

function rotl(x, n) {
  n = BigInt(n) & 63n;
  return (((x << n) | (x >> (64n - n))) & MASK);
}

function keccakF(s) {
  for (let r = 0; r < 24; r++) {
    const c = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) {
      c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    }
    const d = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) s[x + 5 * y] ^= d[x];
    }
    const b = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        s[x + 5 * y] =
          b[x + 5 * y] ^
          ((~b[((x + 1) % 5) + 5 * y] & MASK) & b[((x + 2) % 5) + 5 * y]);
      }
    }
    s[0] ^= RC[r];
    for (let i = 0; i < 25; i++) s[i] &= MASK;
  }
}

function keccak256(bytes) {
  const rate = 136;
  const s = new Array(25).fill(0n);
  let off = 0;
  while (bytes.length - off >= rate) {
    for (let i = 0; i < rate; i++) {
      const lane = i >> 3;
      const byte = i & 7;
      s[lane] ^= BigInt(bytes[off + i]) << BigInt(byte * 8);
    }
    keccakF(s);
    off += rate;
  }
  const pad = new Uint8Array(rate);
  pad.set(bytes.subarray(off));
  pad[bytes.length - off] = 0x01;
  pad[rate - 1] |= 0x80;
  for (let i = 0; i < rate; i++) {
    const lane = i >> 3;
    const byte = i & 7;
    s[lane] ^= BigInt(pad[i]) << BigInt(byte * 8);
  }
  keccakF(s);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const lane = i >> 3;
    const byte = i & 7;
    out[i] = Number((s[lane] >> BigInt(byte * 8)) & 0xffn);
  }
  return out;
}

function keccak256Hex(text) {
  const hash = keccak256(new TextEncoder().encode(text));
  return "0x" + Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Etherscan client --------------------------------------------

const ENDPOINT = "https://api.etherscan.io/v2/api";
const CHAIN_ID = 1;
const RATE_LIMIT_MS = 220; // ~4.5 rps, safely under free-tier 5 rps

let lastCall = 0;
async function throttle() {
  const wait = lastCall + RATE_LIMIT_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

async function etherscan(params) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) throw new Error("ETHERSCAN_API_KEY missing (see .env.example)");
  const qs = new URLSearchParams({
    chainid: String(CHAIN_ID),
    apikey: apiKey,
    ...params,
  });
  const url = `${ENDPOINT}?${qs}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    await throttle();
    let res, body;
    try {
      res = await fetch(url);
      body = await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    if (body.status === "1") return body.result;
    // Etherscan returns status="0" with various "No ... found" messages and an
    // empty-array result for empty result sets — treat as success.
    if (
      body.status === "0" &&
      Array.isArray(body.result) &&
      body.result.length === 0
    ) {
      return [];
    }
    // eth_call (proxy) returns { jsonrpc, id, result } directly with no status.
    if (body.result !== undefined && body.status === undefined) return body.result;
    if (
      body.message === "NOTOK" ||
      (body.result && String(body.result).includes("rate limit"))
    ) {
      if (attempt === 3) throw new Error(`Etherscan: ${body.result || body.message}`);
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      continue;
    }
    throw new Error(`Etherscan: ${JSON.stringify(body)}`);
  }
  throw new Error("Etherscan: exhausted retries");
}

async function getContractCreation(address) {
  const r = await etherscan({
    module: "contract",
    action: "getcontractcreation",
    contractaddresses: address,
  });
  return r[0];
}

async function getAbi(address) {
  const r = await etherscan({
    module: "contract",
    action: "getabi",
    address,
  });
  return JSON.parse(r);
}

// Daily TRY→USD reference rates from the ECB via api.frankfurter.dev. Used
// to express TRY-denominated TVL as USD on the chart. Free, no API key.
// Honours a TRY_USD env override (flat rate) when set.
async function fetchTryUsdRates(startDate, endDate) {
  const flat = parseFloat(process.env.TRY_USD || "");
  if (Number.isFinite(flat) && flat > 0) {
    console.log(`  using flat TRY/USD = ${flat} from TRY_USD env`);
    return { kind: "flat", rate: flat };
  }
  const url = `https://api.frankfurter.dev/v1/${startDate}..${endDate}?base=TRY&symbols=USD`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      const body = await res.json();
      if (body && body.rates && Object.keys(body.rates).length) {
        return { kind: "daily", rates: body.rates };
      }
      throw new Error(`unexpected payload: ${JSON.stringify(body).slice(0, 200)}`);
    } catch (err) {
      console.warn(`  Frankfurter attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt === 2) return null;
      await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
    }
  }
  return null;
}

async function ethCall(to, data) {
  return etherscan({
    module: "proxy",
    action: "eth_call",
    to,
    data,
    tag: "latest",
  });
}

async function getLogsPage(address, fromBlock, topics) {
  const params = {
    module: "logs",
    action: "getLogs",
    address,
    fromBlock: String(fromBlock),
    toBlock: "latest",
    page: "1",
    offset: "1000",
  };
  topics.forEach((t, i) => {
    if (t) params[`topic${i}`] = t;
    if (t && i > 0) params[`topic0_${i}_opr`] = "and";
  });
  return etherscan(params);
}

async function getAllLogs(label, address, topics, startBlock) {
  const cachePath = resolve(DATA_DIR, `logs-${label}.json`);
  let cached = { fromBlock: startBlock, logs: [] };
  if (existsSync(cachePath)) {
    cached = JSON.parse(readFileSync(cachePath, "utf8"));
    if (cached.fromBlock < startBlock) cached.fromBlock = startBlock;
  }
  const seen = new Set(cached.logs.map((l) => `${l.blockNumber}-${l.logIndex}`));
  let cursor = cached.fromBlock;
  console.log(`  [${label}] starting from block ${cursor}`);
  while (true) {
    const page = await getLogsPage(address, cursor, topics);
    if (!page.length) break;
    let added = 0;
    let maxBlock = cursor;
    for (const log of page) {
      const key = `${log.blockNumber}-${log.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cached.logs.push(log);
      added++;
      const bn = parseInt(log.blockNumber, 16);
      if (bn > maxBlock) maxBlock = bn;
    }
    console.log(
      `  [${label}] page=${page.length} new=${added} total=${cached.logs.length} block=${maxBlock}`,
    );
    if (page.length < 1000) {
      cursor = maxBlock + 1;
      break;
    }
    if (maxBlock <= cursor) {
      // Safety: more than 1000 events in a single block — bump anyway.
      cursor = maxBlock + 1;
    } else {
      cursor = maxBlock;
    }
  }
  cached.fromBlock = cursor;
  cached.logs.sort((a, b) => {
    const da = parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16);
    if (da !== 0) return da;
    return parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16);
  });
  writeFileSync(cachePath, JSON.stringify(cached));
  return cached.logs;
}


// ---------- RedStone TRY logs via Etherscan v2 (chain 4326) ----------
//
// Etherscan v2 is multichain — passing chainid=4326 routes the same key
// at the MegaETH explorer. Reuses the existing `etherscan(...)` helper
// (rate limit, retries, cache file format) and the `getLogsPage` paging
// pattern, just with chainid overridden in the params.

function decodeValueUpdate(data) {
  const d = data.startsWith("0x") ? data.slice(2) : data;
  if (d.length < 192) return null;
  const value = BigInt("0x" + d.slice(0, 64));
  const dataFeedId = "0x" + d.slice(64, 128);
  const updatedAt = parseInt(d.slice(128, 192), 16);
  return { value, dataFeedId, updatedAt };
}

// Page through ValueUpdate logs from the RedStone multi-feed adapter on
// MegaETH, decode each event and keep only TRY rows (the adapter emits
// 8+ feeds; storing all of them would bloat the cache). Cache schema:
// `{ fromBlock, rows: [{b, li, t, u, v}] }` — block, logIndex, block
// timestamp, RedStone-source updatedAt, and decoded usdPerTry.
async function fetchRedstoneTryUpdates() {
  const cachePath = resolve(DATA_DIR, "logs-redstone-try-megaeth.json");
  let cached = { fromBlock: REDSTONE_FEED_START_BLOCK, rows: [] };
  if (existsSync(cachePath)) {
    cached = JSON.parse(readFileSync(cachePath, "utf8"));
    if (cached.fromBlock < REDSTONE_FEED_START_BLOCK)
      cached.fromBlock = REDSTONE_FEED_START_BLOCK;
  }
  const seen = new Set(cached.rows.map((r) => `${r.b}-${r.li}`));
  const PAGE_CAP = 1000;
  // Etherscan v2 query-timeouts when toBlock is "latest" over wide ranges
  // even if the actual result count is small. We chunk into block windows
  // and shrink on cap-hit / timeout. The window adapts so we cover the
  // whole range with as few calls as possible.
  let windowSize = parseInt(process.env.REDSTONE_BLOCK_WINDOW || "20000", 10);
  let cursor = cached.fromBlock;
  // Get latest MegaETH block once so we know when to stop.
  let latestBlock;
  try {
    const r = await etherscan({
      chainid: String(REDSTONE_CHAIN_ID),
      module: "proxy",
      action: "eth_blockNumber",
    });
    latestBlock = parseInt(r, 16);
  } catch {
    latestBlock = cursor + 50_000_000; // fallback ceiling
  }
  console.log(
    `  [redstone-try] starting from block ${cursor} (latest=${latestBlock})`,
  );
  let pages = 0;
  while (cursor <= latestBlock) {
    const toBlock = Math.min(cursor + windowSize, latestBlock);
    let page;
    try {
      page = await etherscan({
        chainid: String(REDSTONE_CHAIN_ID),
        module: "logs",
        action: "getLogs",
        address: REDSTONE_FEED,
        fromBlock: String(cursor),
        toBlock: String(toBlock),
        topic0: VALUE_UPDATE_TOPIC,
        page: "1",
        offset: String(PAGE_CAP),
      });
    } catch (err) {
      // Timeout / "smaller result dataset" — halve the window and retry.
      if (/timeout|smaller result/i.test(err.message) && windowSize > 1000) {
        windowSize = Math.max(1000, Math.floor(windowSize / 2));
        console.warn(
          `  [redstone-try] timeout, shrinking window to ${windowSize}`,
        );
        continue;
      }
      throw err;
    }
    let kept = 0;
    let maxBlock = cursor;
    for (const log of page) {
      const dec = decodeValueUpdate(log.data || "");
      if (!dec) continue;
      const bn = parseInt(log.blockNumber, 16);
      const li = parseInt(log.logIndex, 16);
      const ts = parseInt(log.timeStamp, 16);
      if (bn > maxBlock) maxBlock = bn;
      if (dec.dataFeedId.toLowerCase() !== TRY_FEED_ID.toLowerCase())
        continue;
      const key = `${bn}-${li}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const v = Number(dec.value) / 10 ** REDSTONE_DECIMALS;
      if (!Number.isFinite(v) || v <= 0) continue;
      const u = dec.updatedAt > 1e12 ? Math.floor(dec.updatedAt / 1000) : dec.updatedAt;
      cached.rows.push({ b: bn, li, t: ts, u, v });
      kept++;
    }
    pages++;
    console.log(
      `  [redstone-try] [${cursor}..${toBlock}] page=${page.length} TRY-new=${kept} TRY-total=${cached.rows.length}`,
    );
    if (page.length >= PAGE_CAP) {
      // Hit the result cap — shrink the window so we don't miss events.
      windowSize = Math.max(1000, Math.floor(windowSize / 2));
      cursor = maxBlock + 1;
    } else {
      cursor = toBlock + 1;
      // Sparse range — grow the window to reduce round-trips.
      if (page.length < PAGE_CAP / 4) {
        windowSize = Math.min(200_000, Math.floor(windowSize * 1.5));
      }
    }
    if (pages % 20 === 0) {
      cached.fromBlock = cursor;
      writeFileSync(cachePath, JSON.stringify(cached));
    }
  }
  cached.fromBlock = cursor;
  cached.rows.sort((a, b) => a.b - b.b || a.li - b.li);
  writeFileSync(cachePath, JSON.stringify(cached));
  return cached.rows.map((r) => ({
    blockNumber: r.b,
    timeStamp: r.t,
    updatedAt: r.u,
    usdPerTry: r.v,
  }));
}

// Fetch all transactions to `address` whose input begins with `selector`,
// merging external (txlist) and internal (txlistinternal) call traces. Used
// for oracles that update via setter calls without emitting events.
async function getAllTxsTo(label, address, selector, startBlock) {
  const cachePath = resolve(DATA_DIR, `txs-${label}.json`);
  let cached = { fromBlock: startBlock, txs: [] };
  if (existsSync(cachePath)) {
    cached = JSON.parse(readFileSync(cachePath, "utf8"));
    if (cached.fromBlock < startBlock) cached.fromBlock = startBlock;
  }
  const seen = new Set(
    cached.txs.map((t) => `${t.hash}:${t.traceId || ""}`),
  );
  const baseCursor = cached.fromBlock;
  console.log(`  [${label}] starting from block ${baseCursor}`);

  const sources = [
    { module: "account", action: "txlist" },
    { module: "account", action: "txlistinternal" },
  ];
  for (const src of sources) {
    let cursor = baseCursor;
    while (true) {
      const page = await etherscan({
        ...src,
        address,
        startblock: String(cursor),
        endblock: "99999999",
        sort: "asc",
        page: "1",
        offset: "10000",
      });
      if (!page.length) break;
      let added = 0;
      let maxBlock = cursor;
      for (const tx of page) {
        if (tx.isError === "1") continue;
        if (!tx.to || tx.to.toLowerCase() !== address.toLowerCase()) continue;
        if (!tx.input || !tx.input.startsWith(selector)) continue;
        const key = `${tx.hash}:${tx.traceId || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cached.txs.push({
          blockNumber: parseInt(tx.blockNumber, 10),
          timeStamp: parseInt(tx.timeStamp, 10),
          input: tx.input,
          hash: tx.hash,
          traceId: tx.traceId || "",
        });
        added++;
        const bn = parseInt(tx.blockNumber, 10);
        if (bn > maxBlock) maxBlock = bn;
      }
      console.log(
        `  [${label}/${src.action}] page=${page.length} new=${added} block=${maxBlock}`,
      );
      if (page.length < 10000) break;
      if (maxBlock <= cursor) break;
      cursor = maxBlock;
    }
  }
  cached.fromBlock = cached.txs.length
    ? Math.max(...cached.txs.map((t) => t.blockNumber)) + 1
    : baseCursor;
  cached.txs.sort(
    (a, b) =>
      a.blockNumber - b.blockNumber || a.hash.localeCompare(b.hash),
  );
  writeFileSync(cachePath, JSON.stringify(cached));
  return cached.txs;
}

// ---------- ABI helpers --------------------------------------------------

function canonicalType(input) {
  // Tuples encode as "(type1,type2,...)". Keep arrays.
  if (input.type.startsWith("tuple")) {
    const inner = input.components.map(canonicalType).join(",");
    return `(${inner})${input.type.slice(5)}`;
  }
  return input.type;
}

function eventSignature(ev) {
  return `${ev.name}(${ev.inputs.map(canonicalType).join(",")})`;
}

function eventTopic(ev) {
  return keccak256Hex(eventSignature(ev));
}

function findUpdateEvent(abi) {
  const events = abi.filter((x) => x.type === "event" && !x.anonymous);
  const ranked = events
    .map((ev) => {
      const name = ev.name.toLowerCase();
      let score = 0;
      if (/answerupdated/.test(name)) score += 10;
      if (/nav/.test(name)) score += 8;
      if (/price/.test(name)) score += 5;
      if (/update|publish|set/.test(name) && !/owner/.test(name)) score += 3;
      if (/round/.test(name)) score += 1;
      const firstNonIndexed = ev.inputs.find((i) => !i.indexed);
      if (
        firstNonIndexed &&
        /^(u?int)(\d+)?$/.test(firstNonIndexed.type)
      ) {
        score += 2;
      }
      return { ev, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked.length ? ranked[0].ev : null;
}

// Setter-function fallback for oracles that don't emit events on update.
function findUpdateFunction(abi) {
  const fns = abi.filter(
    (x) =>
      x.type === "function" &&
      x.stateMutability !== "view" &&
      x.stateMutability !== "pure" &&
      !/^(renounce|transfer)ownership$/i.test(x.name || ""),
  );
  const ranked = fns
    .map((fn) => {
      const name = (fn.name || "").toLowerCase();
      let score = 0;
      if (/^(setprice|setnav|setanswer|push|submit)/.test(name)) score += 10;
      if (/^update/.test(name)) score += 6;
      if (/^set/.test(name)) score += 3;
      if (/price|nav|answer|value/.test(name)) score += 4;
      const firstArg = fn.inputs[0];
      if (firstArg && /^(u?int)(\d+)?$/.test(firstArg.type)) score += 2;
      return { fn, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked.length ? ranked[0].fn : null;
}

function functionSignature(fn) {
  return `${fn.name}(${fn.inputs.map(canonicalType).join(",")})`;
}

function functionSelector(fn) {
  // First 4 bytes of keccak256(signature) → "0x" + 8 hex chars.
  return keccak256Hex(functionSignature(fn)).slice(0, 10);
}

// Decode a 256-bit unsigned integer from a tx's input data, where `slot` is
// the zero-indexed 32-byte argument slot after the 4-byte selector.
function decodeUint256At(input, slot) {
  const start = 2 + 8 + slot * 64;
  return BigInt("0x" + input.slice(start, start + 64));
}

// Decode the first non-indexed argument of an event log as a 256-bit integer.
function decodeFirstNonIndexed(ev, log) {
  const idx = ev.inputs.findIndex((i) => !i.indexed);
  if (idx < 0) throw new Error("event has no non-indexed inputs");
  // Each non-indexed argument occupies 32 bytes in `data`. Find which slot.
  let slot = 0;
  for (let i = 0; i < idx; i++) if (!ev.inputs[i].indexed) slot++;
  const hex = log.data.slice(2 + slot * 64, 2 + (slot + 1) * 64);
  let n = BigInt("0x" + hex);
  // Treat as signed if the input type is intN.
  const t = ev.inputs[idx].type;
  if (t.startsWith("int")) {
    const limit = 1n << 255n;
    if (n >= limit) n = n - (1n << 256n);
  }
  return n;
}

// ---------- Replay --------------------------------------------------------

const DAY = 86400;

function dayOf(ts) {
  return Math.floor(ts / DAY);
}

function isoDay(dayIdx) {
  return new Date(dayIdx * DAY * 1000).toISOString().slice(0, 10);
}

function bigToFloat(value, decimals) {
  // Convert a BigInt with `decimals` places to a JS number. Loses precision
  // beyond ~15 significant digits, which is fine for plotting.
  const negative = value < 0n;
  let abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const num = Number(whole) + Number(frac) / Number(scale);
  return negative ? -num : num;
}

async function main() {
  loadEnv();
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(WEB_DIR)) mkdirSync(WEB_DIR, { recursive: true });

  console.log("Discovering NAV feed update method...");
  const navAbi = await getAbi(NAV_FEED);
  const navEvent = findUpdateEvent(navAbi);
  let navMethod;
  if (navEvent) {
    navMethod = {
      kind: "event",
      item: navEvent,
      signature: eventSignature(navEvent),
      selector: eventTopic(navEvent),
    };
  } else {
    const fn = findUpdateFunction(navAbi);
    if (!fn) throw new Error("Could not identify NAV update method");
    navMethod = {
      kind: "function",
      item: fn,
      signature: functionSignature(fn),
      selector: functionSelector(fn),
    };
  }
  console.log(`  NAV ${navMethod.kind}: ${navMethod.signature}`);
  console.log(`  selector  : ${navMethod.selector}`);

  console.log("Reading on-chain decimals...");
  // selector for decimals(): 0x313ce567
  let itryDecimals = 18;
  try {
    const r = await ethCall(ITRY, "0x313ce567");
    if (r && r !== "0x") itryDecimals = parseInt(r, 16);
  } catch (e) {
    console.warn(`  iTRY decimals lookup failed (${e.message}); assuming 18`);
  }
  // NAV decimals: if the contract exposes decimals() use it; otherwise default
  // to 18, overridable via NAV_DECIMALS env var.
  let navDecimals = 18;
  const navDecimalsOverride = parseInt(process.env.NAV_DECIMALS || "", 10);
  if (Number.isFinite(navDecimalsOverride)) {
    navDecimals = navDecimalsOverride;
  } else {
    try {
      const r = await ethCall(NAV_FEED, "0x313ce567");
      if (r && r !== "0x" && r.length >= 66) navDecimals = parseInt(r, 16);
    } catch {}
  }
  console.log(`  iTRY decimals=${itryDecimals}, NAV decimals=${navDecimals}`);

  console.log("Locating contract creation blocks...");
  const [itryCreation, witryCreation, navCreation] = await Promise.all([
    getContractCreation(ITRY),
    getContractCreation(WITRY),
    getContractCreation(NAV_FEED),
  ]);
  const startBlock = Math.min(
    parseInt(itryCreation.blockNumber, 10),
    parseInt(witryCreation.blockNumber, 10),
    parseInt(navCreation.blockNumber, 10),
  );
  console.log(`  earliest deployment block: ${startBlock}`);

  console.log("Fetching iTRY/wiTRY transfer logs (cached under ./data)...");
  const itryTransfers = await getAllLogs(
    "itry-transfer",
    ITRY,
    [TRANSFER_TOPIC],
    startBlock,
  );
  const witryTransfers = await getAllLogs(
    "witry-transfer",
    WITRY,
    [TRANSFER_TOPIC],
    startBlock,
  );

  console.log("Fetching NAV update history...");
  let navUpdates;
  if (navMethod.kind === "event") {
    const logs = await getAllLogs(
      "nav-update",
      NAV_FEED,
      [navMethod.selector],
      startBlock,
    );
    navUpdates = logs.map((log) => ({
      blockNumber: parseInt(log.blockNumber, 16),
      logIndex: parseInt(log.logIndex, 16),
      timeStamp: parseInt(log.timeStamp, 16),
      value: decodeFirstNonIndexed(navMethod.item, log),
    }));
  } else {
    const txs = await getAllTxsTo(
      "nav-setprice",
      NAV_FEED,
      navMethod.selector,
      startBlock,
    );
    navUpdates = txs.map((tx) => ({
      blockNumber: tx.blockNumber,
      logIndex: 0,
      timeStamp: tx.timeStamp,
      value: decodeUint256At(tx.input, 0),
    }));
  }
  console.log(
    `  iTRY transfers=${itryTransfers.length}, wiTRY transfers=${witryTransfers.length}, NAV updates=${navUpdates.length}`,
  );

  console.log("Classifying iTRY → wiTRY inflows (deposit vs yield)...");
  const witryAddrLower = WITRY.toLowerCase();
  // A transfer of iTRY into the wiTRY vault is "yield" iff no wiTRY shares
  // are minted in the same transaction. Deposits mint shares proportionally;
  // pure yield drops bump totalAssets without touching totalSupply, which is
  // exactly what raises share price. This invariant is robust against
  // changes in the protocol's yield-routing internals.
  const witryMintTxHashes = new Set();
  for (const l of witryTransfers) {
    const from = "0x" + l.topics[1].slice(26);
    if (from === ZERO) witryMintTxHashes.add(l.transactionHash);
  }
  // Pre-compute "this tx delivered iTRY into wiTRY" — used to split iTRY
  // mints into yield (lands in vault same-tx) vs primary issuance (does not).
  const txsDeliveringToVault = new Set();
  for (const l of itryTransfers) {
    const to = ("0x" + l.topics[2].slice(26)).toLowerCase();
    if (to === witryAddrLower) txsDeliveringToVault.add(l.transactionHash);
  }
  const yieldByDay = new Map(); // dayIdx -> BigInt iTRY-wei delivered
  for (const l of itryTransfers) {
    const to = ("0x" + l.topics[2].slice(26)).toLowerCase();
    if (to !== witryAddrLower) continue;
    if (witryMintTxHashes.has(l.transactionHash)) continue; // deposit
    const day = dayOf(parseInt(l.timeStamp, 16));
    const amt = BigInt(l.data);
    yieldByDay.set(day, (yieldByDay.get(day) || 0n) + amt);
  }
  // Primary issuance = iTRY mint whose tx did NOT route into the vault.
  // Yield-related mints route through the Yield Forwarder → ... → wiTRY all
  // in the same transaction, so the same-tx-vault-delivery check separates
  // them cleanly without caring about which intermediary contracts are used.
  const primaryByDay = new Map();
  for (const l of itryTransfers) {
    const from = "0x" + l.topics[1].slice(26);
    if (from !== ZERO) continue;
    if (txsDeliveringToVault.has(l.transactionHash)) continue; // yield mint
    const day = dayOf(parseInt(l.timeStamp, 16));
    const amt = BigInt(l.data);
    primaryByDay.set(day, (primaryByDay.get(day) || 0n) + amt);
  }
  console.log(
    `  classified ${yieldByDay.size} yield day(s), ${primaryByDay.size} primary-issuance day(s)`,
  );

  console.log("Replaying events into daily snapshots...");

  function fromLog(kind, log) {
    return {
      kind,
      blockNumber: parseInt(log.blockNumber, 16),
      logIndex: parseInt(log.logIndex, 16),
      timeStamp: parseInt(log.timeStamp, 16),
      log,
    };
  }
  const stream = [];
  for (const l of itryTransfers) stream.push(fromLog("itry", l));
  for (const l of witryTransfers) stream.push(fromLog("witry", l));
  for (const u of navUpdates) {
    stream.push({
      kind: "nav",
      blockNumber: u.blockNumber,
      logIndex: u.logIndex,
      timeStamp: u.timeStamp,
      value: u.value,
    });
  }
  stream.sort(
    (a, b) =>
      a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  );

  let itrySupply = 0n; // total iTRY in circulation (wei units)
  let witryAssets = 0n; // iTRY held by wiTRY
  let witrySupply = 0n; // total wiTRY shares
  let navWei = 0n; // last NAV value (NAV-decimal units)

  const snapshots = [];
  let lastDay = null;

  function flushTo(day) {
    if (lastDay === null) {
      lastDay = day;
      return;
    }
    while (lastDay < day) {
      snapshots.push({
        day: lastDay,
        itrySupply,
        witryAssets,
        witrySupply,
        navWei,
      });
      lastDay++;
    }
  }

  for (const ev of stream) {
    flushTo(dayOf(ev.timeStamp));
    if (ev.kind === "itry") {
      const from = "0x" + ev.log.topics[1].slice(26);
      const to = "0x" + ev.log.topics[2].slice(26);
      const amount = BigInt(ev.log.data);
      if (from === ZERO) itrySupply += amount;
      else if (from.toLowerCase() === witryAddrLower) witryAssets -= amount;
      if (to === ZERO) itrySupply -= amount;
      else if (to.toLowerCase() === witryAddrLower) witryAssets += amount;
    } else if (ev.kind === "witry") {
      const from = "0x" + ev.log.topics[1].slice(26);
      const to = "0x" + ev.log.topics[2].slice(26);
      const amount = BigInt(ev.log.data);
      if (from === ZERO) witrySupply += amount;
      if (to === ZERO) witrySupply -= amount;
    } else if (ev.kind === "nav") {
      navWei = ev.value;
    }
  }

  // Append today's running state so the chart extends to "now".
  const today = dayOf(Math.floor(Date.now() / 1000));
  if (lastDay !== null) {
    while (lastDay <= today) {
      snapshots.push({
        day: lastDay,
        itrySupply,
        witryAssets,
        witrySupply,
        navWei,
      });
      lastDay++;
    }
  }

  // Hard cutoff at the protocol launch date — overridable via env var.
  // Defaults to the Monday before the first user-visible deposits.
  const startDateStr = process.env.CHART_START_DATE || "2026-03-23";
  const startDay = Math.floor(
    Date.parse(startDateStr + "T00:00:00Z") / 1000 / 86400,
  );
  const firstActive = snapshots.findIndex((s) => s.day >= startDay);
  if (firstActive > 0) {
    snapshots.splice(0, firstActive);
    console.log(
      `  trimmed ${firstActive} pre-launch day(s); chart starts ${startDateStr}`,
    );
  } else if (firstActive < 0) {
    console.warn(
      `  CHART_START_DATE ${startDateStr} is after all snapshots; nothing to plot`,
    );
  }

  console.log(`  produced ${snapshots.length} daily snapshots`);

  console.log("Deriving series...");
  const days = snapshots.map((s) => isoDay(s.day));
  const iTrySupplyDaily = snapshots.map((s) => bigToFloat(s.itrySupply, itryDecimals));
  // wiTRY inherits the underlying's decimals (ERC-4626 standard).
  const witrySupplyDaily = snapshots.map((s) => bigToFloat(s.witrySupply, itryDecimals));
  // iTRY currently held by the wiTRY vault contract (= iTRY locked).
  const iTryLockedDaily = snapshots.map((s) => bigToFloat(s.witryAssets, itryDecimals));
  // "Unwrapped iTRY" = iTRY in user wallets = total iTRY − iTRY held by vault.
  // (Brix's homepage subtracts the share count instead, which inflates this
  // number by the accrued yield. We use the strict on-chain ledger figure.)
  const unwrappedITryDaily = snapshots.map((s) =>
    bigToFloat(s.itrySupply - s.witryAssets, itryDecimals),
  );
  const wiTryPerITry = snapshots.map((s) =>
    s.witrySupply === 0n ? null : Number((s.witryAssets * 10n ** 18n) / s.witrySupply) / 1e18,
  );
  const navTry = snapshots.map((s) => bigToFloat(s.navWei, navDecimals));
  const wiTryTry = snapshots.map((s, i) =>
    wiTryPerITry[i] === null ? null : wiTryPerITry[i] * navTry[i],
  );
  const iTryTvlTry = snapshots.map((s, i) =>
    bigToFloat(s.itrySupply, itryDecimals) * navTry[i],
  );
  const wiTryTvlTry = snapshots.map((s, i) =>
    bigToFloat(s.witryAssets, itryDecimals) * navTry[i],
  );
  // Daily yield delivered to the wiTRY vault, in iTRY (and TRY via NAV).
  // A "yield event" is an iTRY → wiTRY transfer in a tx that did not mint
  // wiTRY shares (i.e. wasn't a deposit). Cumulative series is the running
  // total across the chart window.
  const yieldITryDaily = snapshots.map(
    (s) => bigToFloat(yieldByDay.get(s.day) || 0n, itryDecimals),
  );
  const yieldTryDaily = yieldITryDaily.map((v, i) => v * navTry[i]);
  let cumY = 0;
  const yieldITryCumulative = yieldITryDaily.map((v) => (cumY += v));
  let cumYT = 0;
  const yieldTryCumulative = yieldTryDaily.map((v) => (cumYT += v));
  const primaryITryDaily = snapshots.map(
    (s) => bigToFloat(primaryByDay.get(s.day) || 0n, itryDecimals),
  );
  const primaryTryDaily = primaryITryDaily.map((v, i) => v * navTry[i]);
  let cumP = 0;
  const primaryITryCumulative = primaryITryDaily.map((v) => (cumP += v));

  console.log("Fetching TRY/USD daily rates from Frankfurter (ECB)...");
  const fx = await fetchTryUsdRates(days[0], days[days.length - 1]);
  const usdPerTry = new Array(days.length).fill(null);
  if (fx && fx.kind === "flat") {
    usdPerTry.fill(fx.rate);
  } else if (fx && fx.kind === "daily") {
    let last = null;
    for (let i = 0; i < days.length; i++) {
      const r = fx.rates[days[i]];
      if (r && typeof r.USD === "number") last = r.USD;
      usdPerTry[i] = last;
    }
    // Backfill leading nulls (chart starts before first ECB rate) with the
    // first known rate so the USD series has no gaps.
    const firstKnown = usdPerTry.find((v) => v != null);
    for (let i = 0; i < usdPerTry.length; i++) {
      if (usdPerTry[i] == null) usdPerTry[i] = firstKnown;
    }
    console.log(`  got ${Object.keys(fx.rates).length} ECB business-day rates`);
  } else {
    console.warn(
      "  No TRY/USD rates available — USD series will be null. Pass TRY_USD=<rate> env to override.",
    );
  }

  // ---- RedStone on-chain TRY/USD (MegaETH) -----------------------------
  // Additive: we keep the Frankfurter `usdPerTry` series as-is for prod,
  // and emit a parallel series under `redstone.dailyAvgUsdPerTry` for the
  // /staging variant to consume. Per-update raw points (`tryUsdUpdates`)
  // drive the new on-chain TRY/USD chart.
  console.log("Fetching RedStone TRY/USD updates via Etherscan v2 (chain 4326, MegaETH)...");
  let redstoneUpdates = [];
  try {
    redstoneUpdates = await fetchRedstoneTryUpdates();
    console.log(`  got ${redstoneUpdates.length} TRY ValueUpdate events`);
  } catch (err) {
    console.warn(`  RedStone fetch failed: ${err.message}`);
  }

  // Live spot from the dedicated Chainlink-style adapter — single eth_call
  // (selector 0x50d25bcd = `latestAnswer()`). The result is the exact same
  // value the multi-feed adapter currently has for TRY, but reading it via
  // the TRY-specific aggregator keeps the source of truth crisp and lets
  // us add a "now" point even when the trailing event window had no TRY
  // updates yet for the day. We tag it with the latest known MegaETH block
  // timestamp via eth_blockNumber + eth_getBlockByNumber.
  let redstoneLatest = null;
  try {
    const ans = await etherscan({
      chainid: String(REDSTONE_CHAIN_ID),
      module: "proxy",
      action: "eth_call",
      to: REDSTONE_TRY_AGGREGATOR,
      data: "0x50d25bcd",
      tag: "latest",
    });
    if (ans && ans !== "0x") {
      const raw = BigInt(ans);
      const usd = Number(raw) / 10 ** REDSTONE_DECIMALS;
      const blockHex = await etherscan({
        chainid: String(REDSTONE_CHAIN_ID),
        module: "proxy",
        action: "eth_blockNumber",
      });
      const block = parseInt(blockHex, 16);
      const blk = await etherscan({
        chainid: String(REDSTONE_CHAIN_ID),
        module: "proxy",
        action: "eth_getBlockByNumber",
        tag: blockHex,
        boolean: "false",
      });
      const ts = parseInt(blk.timestamp, 16);
      redstoneLatest = {
        usdPerTry: usd,
        blockNumber: block,
        timeStamp: ts,
        source: REDSTONE_TRY_AGGREGATOR,
      };
      console.log(
        `  live latestAnswer() on ${REDSTONE_TRY_AGGREGATOR}: ${usd.toFixed(8)} USD/TRY @ block ${block}`,
      );
      // Append as a fresh sample point, de-duped by exact (timestamp, value)
      const dup = redstoneUpdates.some(
        (u) => u.timeStamp === ts && Math.abs(u.usdPerTry - usd) < 1e-12,
      );
      if (!dup) {
        redstoneUpdates = [
          ...redstoneUpdates,
          {
            blockNumber: block,
            timeStamp: ts,
            updatedAt: ts,
            usdPerTry: usd,
          },
        ].sort((a, b) => a.timeStamp - b.timeStamp);
      }
    }
  } catch (err) {
    console.warn(`  RedStone live spot failed: ${err.message}`);
  }
  // Group by UTC day → arithmetic mean of usdPerTry per day.
  const redstoneByDay = new Map(); // ISO day → { sum, n }
  for (const u of redstoneUpdates) {
    const isoYmd = isoDay(dayOf(u.timeStamp));
    const acc = redstoneByDay.get(isoYmd) || { sum: 0, n: 0 };
    acc.sum += u.usdPerTry;
    acc.n += 1;
    redstoneByDay.set(isoYmd, acc);
  }
  const redstoneDailyAvg = new Array(days.length).fill(null);
  let lastAvg = null;
  for (let i = 0; i < days.length; i++) {
    const acc = redstoneByDay.get(days[i]);
    if (acc) lastAvg = acc.sum / acc.n;
    redstoneDailyAvg[i] = lastAvg;
  }
  const firstRedstoneDay = days.findIndex((d) => redstoneByDay.has(d));
  console.log(
    firstRedstoneDay >= 0
      ? `  RedStone covers ${days[firstRedstoneDay]} → ${days.at(-1)} (${redstoneByDay.size} days w/ updates)`
      : "  No RedStone updates land within the chart window",
  );

  // Downsample per-update points for the on-chain TRY/USD chart so the
  // static JSON stays compact (the raw cache can hold 1M+ rows). One median
  // sample per `REDSTONE_BUCKET_SECS` (default 5 min) is plenty for a
  // long-window line chart and still shows the intra-day movement.
  const bucketSecs = Math.max(
    60,
    parseInt(process.env.REDSTONE_BUCKET_SECS || "300", 10),
  );
  const buckets = new Map(); // bucketKey → array of usdPerTry values
  for (const u of redstoneUpdates) {
    const key = Math.floor(u.timeStamp / bucketSecs);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(u.usdPerTry);
  }
  const tryUsdSamples = Array.from(buckets.entries())
    .map(([k, vs]) => {
      vs.sort((a, b) => a - b);
      const med = vs[Math.floor(vs.length / 2)];
      return { t: k * bucketSecs, usd: med };
    })
    .sort((a, b) => a.t - b.t);

  const redstoneSnapshot = {
    source: "MegaEthReferenceMultiFeedAdapterWithoutRoundsV1",
    contract: REDSTONE_FEED,
    aggregator: REDSTONE_TRY_AGGREGATOR,
    chain: "megaeth",
    chainId: REDSTONE_CHAIN_ID,
    decimals: REDSTONE_DECIMALS,
    bucketSecs,
    rawUpdateCount: redstoneUpdates.length,
    daysWithUpdates: redstoneByDay.size,
    latest: redstoneLatest,
    tryUsdSamples,
    dailyAvgUsdPerTry: redstoneDailyAvg,
  };

  const wiTryUsd = wiTryTry.map((v, i) =>
    v == null || usdPerTry[i] == null ? null : v * usdPerTry[i],
  );
  const iTryTvlUsd = iTryTvlTry.map((v, i) =>
    usdPerTry[i] == null ? null : v * usdPerTry[i],
  );
  const wiTryTvlUsd = wiTryTvlTry.map((v, i) =>
    usdPerTry[i] == null ? null : v * usdPerTry[i],
  );
  const yieldUsdDaily = yieldTryDaily.map((v, i) =>
    usdPerTry[i] == null ? null : v * usdPerTry[i],
  );
  const primaryUsdDaily = primaryTryDaily.map((v, i) =>
    usdPerTry[i] == null ? null : v * usdPerTry[i],
  );

  // Trailing N-day APY using SIMPLE (linear) annualization:
  //   APY = (price_now / price_window − 1) × (365 / N)
  // Brix is a passthrough yield wrapper: Turkish T-bill coupons are minted
  // into the vault but not reinvested into more bonds, so the underlying
  // yield rate doesn't compound. Linear annualization matches that economic
  // reality and aligns with brix.money's own published APY.
  function trailingApy(values, window) {
    if (values.length <= window) return null;
    const end = values[values.length - 1];
    const start = values[values.length - 1 - window];
    if (end == null || start == null || start <= 0 || end <= 0) return null;
    const ret = end / start - 1;
    if (!Number.isFinite(ret)) return null;
    return ret * (365 / window);
  }
  const apy7d = {
    try: trailingApy(wiTryTry, 7),
    usd: trailingApy(wiTryUsd, 7),
  };
  const apy30d = {
    try: trailingApy(wiTryTry, 30),
    usd: trailingApy(wiTryUsd, 30),
  };

  const out = {
    generatedAt: new Date().toISOString(),
    chain: "ethereum",
    contracts: { iTRY: ITRY, wiTRY: WITRY, navFeed: NAV_FEED },
    decimals: { iTRY: itryDecimals, NAV: navDecimals },
    navMethod: { kind: navMethod.kind, signature: navMethod.signature },
    navEvent: navMethod.signature,
    fxSource: fx ? (fx.kind === "flat" ? "TRY_USD env" : "frankfurter.dev (ECB)") : "none",
    redstone: redstoneSnapshot,
    apy7d,
    apy30d,
    days,
    iTrySupply: iTrySupplyDaily,
    witrySupply: witrySupplyDaily,
    iTryLocked: iTryLockedDaily,
    unwrappedITry: unwrappedITryDaily,
    wiTryPerITry,
    navTry,
    wiTryTry,
    iTryTvlTry,
    wiTryTvlTry,
    usdPerTry,
    wiTryUsd,
    iTryTvlUsd,
    wiTryTvlUsd,
    yieldITry: yieldITryDaily,
    yieldTry: yieldTryDaily,
    yieldUsd: yieldUsdDaily,
    yieldITryCumulative,
    yieldTryCumulative,
    primaryITry: primaryITryDaily,
    primaryTry: primaryTryDaily,
    primaryUsd: primaryUsdDaily,
    primaryITryCumulative,
    // Back-compat aliases for any external readers of the old key names.
    navUsd: navTry,
    wiTryUsdc: wiTryTry,
    iTryTvlUsdc: iTryTvlTry,
    wiTryTvlUsdc: wiTryTvlTry,
  };

  const outPath = resolve(WEB_DIR, "snapshots.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outPath}`);
  const pct = (v) => (v == null ? "—" : (v * 100).toFixed(2) + "%");
  console.log(
    `Latest: ${days.at(-1)} | wiTRY/iTRY=${wiTryPerITry.at(-1)} | NAV=${navTry.at(-1)} TRY | iTRY TVL=${iTryTvlTry.at(-1)} TRY (${iTryTvlUsd.at(-1)} USD) | wiTRY TVL=${wiTryTvlTry.at(-1)} TRY (${wiTryTvlUsd.at(-1)} USD) | TRY/USD=${usdPerTry.at(-1)} | APY 7d TRY=${pct(apy7d.try)} USD=${pct(apy7d.usd)} | APY 30d TRY=${pct(apy30d.try)} USD=${pct(apy30d.usd)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

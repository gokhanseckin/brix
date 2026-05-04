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
    // Etherscan returns status="0" with message="No records found" for empty
    // result sets — treat as success with empty array.
    if (
      body.status === "0" &&
      typeof body.message === "string" &&
      body.message.toLowerCase().includes("no records")
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
  // Prefer a name that clearly signals a price/NAV update; fall back to any
  // event whose first non-indexed argument is a uint/int.
  const ranked = events
    .map((ev) => {
      const name = ev.name.toLowerCase();
      let score = 0;
      if (/answerupdated/.test(name)) score += 10;
      if (/nav/.test(name)) score += 8;
      if (/price/.test(name)) score += 5;
      if (/update|publish|set/.test(name)) score += 3;
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
  if (!ranked.length) {
    throw new Error("Could not identify NAV update event in ABI");
  }
  return ranked[0].ev;
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

  console.log("Discovering NAV feed event signature...");
  const navAbi = await getAbi(NAV_FEED);
  const navEvent = findUpdateEvent(navAbi);
  const navTopic = eventTopic(navEvent);
  console.log(`  NAV event: ${eventSignature(navEvent)}`);
  console.log(`  topic0   : ${navTopic}`);

  console.log("Reading on-chain decimals...");
  // selector for decimals(): 0x313ce567
  let itryDecimals = 18;
  let navDecimals = 8;
  try {
    const r = await ethCall(ITRY, "0x313ce567");
    if (r && r !== "0x") itryDecimals = parseInt(r, 16);
  } catch (e) {
    console.warn(`  iTRY decimals lookup failed (${e.message}); assuming 18`);
  }
  try {
    const r = await ethCall(NAV_FEED, "0x313ce567");
    if (r && r !== "0x") navDecimals = parseInt(r, 16);
  } catch (e) {
    console.warn(`  NAV decimals lookup failed (${e.message}); assuming 8`);
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

  console.log("Fetching event logs (cached under ./data)...");
  const [itryTransfers, witryTransfers, navUpdates] = [
    await getAllLogs("itry-transfer", ITRY, [TRANSFER_TOPIC], startBlock),
    await getAllLogs("witry-transfer", WITRY, [TRANSFER_TOPIC], startBlock),
    await getAllLogs("nav-update", NAV_FEED, [navTopic], startBlock),
  ];
  console.log(
    `  iTRY transfers=${itryTransfers.length}, wiTRY transfers=${witryTransfers.length}, NAV updates=${navUpdates.length}`,
  );

  console.log("Replaying events into daily snapshots...");
  const witryAddrLower = WITRY.toLowerCase();

  // Tag and merge into a single ordered stream.
  const stream = [];
  for (const l of itryTransfers) stream.push({ kind: "itry", log: l });
  for (const l of witryTransfers) stream.push({ kind: "witry", log: l });
  for (const l of navUpdates) stream.push({ kind: "nav", log: l });
  stream.sort((a, b) => {
    const ba = parseInt(a.log.blockNumber, 16);
    const bb = parseInt(b.log.blockNumber, 16);
    if (ba !== bb) return ba - bb;
    return parseInt(a.log.logIndex, 16) - parseInt(b.log.logIndex, 16);
  });

  let itrySupply = 0n; // total iTRY in circulation (in wei units)
  let witryAssets = 0n; // iTRY held by wiTRY
  let witrySupply = 0n; // total wiTRY shares
  let navWei = 0n; // last NAV value (in NAV-decimal units)

  const snapshots = []; // [{day, itrySupply, witryAssets, witrySupply, navWei}]
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
    const ts = parseInt(ev.log.timeStamp, 16);
    const d = dayOf(ts);
    flushTo(d);

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
      try {
        navWei = decodeFirstNonIndexed(navEvent, ev.log);
      } catch (e) {
        console.warn(`  NAV decode failed at block ${ev.log.blockNumber}: ${e.message}`);
      }
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

  console.log(`  produced ${snapshots.length} daily snapshots`);

  console.log("Deriving series...");
  const days = snapshots.map((s) => isoDay(s.day));
  const wiTryPerITry = snapshots.map((s) =>
    s.witrySupply === 0n ? null : Number((s.witryAssets * 10n ** 18n) / s.witrySupply) / 1e18,
  );
  const navUsd = snapshots.map((s) => bigToFloat(s.navWei, navDecimals));
  const wiTryUsdc = snapshots.map((s, i) =>
    wiTryPerITry[i] === null ? null : wiTryPerITry[i] * navUsd[i],
  );
  const iTryTvlUsdc = snapshots.map((s, i) =>
    bigToFloat(s.itrySupply, itryDecimals) * navUsd[i],
  );
  const wiTryTvlUsdc = snapshots.map((s, i) =>
    bigToFloat(s.witryAssets, itryDecimals) * navUsd[i],
  );

  const out = {
    generatedAt: new Date().toISOString(),
    chain: "ethereum",
    contracts: { iTRY: ITRY, wiTRY: WITRY, navFeed: NAV_FEED },
    decimals: { iTRY: itryDecimals, NAV: navDecimals },
    navEvent: eventSignature(navEvent),
    days,
    wiTryPerITry,
    wiTryUsdc,
    navUsd,
    iTryTvlUsdc,
    wiTryTvlUsdc,
  };

  const outPath = resolve(WEB_DIR, "snapshots.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${outPath}`);
  console.log(
    `Latest: ${days.at(-1)} | wiTRY/iTRY=${wiTryPerITry.at(-1)} | NAV=${navUsd.at(-1)} | iTRY TVL=${iTryTvlUsdc.at(-1)} | wiTRY TVL=${wiTryTvlUsdc.at(-1)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

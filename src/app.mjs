import * as sp from './sp-core.mjs';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1, schnorr } from '@noble/curves/secp256k1';
import { concatBytes as concat } from '@noble/hashes/utils';
import qrcode from 'qrcode-generator';
import * as btc from '@scure/btc-signer';
import EXAMPLE from './example.json';
import SECP_WASM from '../node_modules/tiny-secp256k1/lib/secp256k1.wasm';
import { initFast, fastReady, fastScanOutputs } from './sp-fast.mjs';
import * as trade from './trade-core.mjs';

const { toHex, fromHex, util } = sp;

// Every network request gets a deadline: a stalled request must never freeze the wallet.
const NET_TIMEOUT_MS = 15000;
const rawFetch = window.fetch.bind(window);
const timedFetch = (input, init = {}) => {
  if (init.signal) return rawFetch(input, init);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), NET_TIMEOUT_MS);
  return rawFetch(input, { ...init, signal: ctl.signal })
    .catch((e) => { throw e?.name === 'AbortError' ? new Error('Network timeout: the server did not answer in time') : e; })
    .finally(() => clearTimeout(t));
};
// Blockchain servers (Esplora API). If one rate-limits (429), errors or times out, the next one is used
// and the first is rested for a minute. A custom server from Settings is always tried first.
const ESPLORA = {
  main: ['https://mempool.space/api/', 'https://blockstream.info/api/'],
  signet: ['https://mempool.space/signet/api/'],
};
const srvRest = new Map(); // base -> resting until (ms)
const srvKey = () => `wren.esplora.${state.net}`;
function customServer() { try { return localStorage.getItem(srvKey()) || ''; } catch { return ''; } }
function serverList() { const c = customServer(); return [...(c ? [c.replace(/\/*$/, '/')] : []), ...ESPLORA[state.net]]; }
function esploraBase() { const l = serverList(); return l.find((b) => (srvRest.get(b) || 0) < Date.now()) || l[0]; }
const srvName = (b) => { try { return new URL(b).host; } catch { return b; } };
let srvRR = 0;
const srvStrikes = new Map();
const scanCtl = { conc: 8, ok: 0, busy: 0 }; // pages fetched at once while scanning; halves on 429, grows back slowly
async function viaServers(path, init) {
  const list = serverList();
  const resting = (b) => (srvRest.get(b) || 0) > Date.now();
  // every server is resting: wait for the first one to come back (max 15 s) instead of failing
  if (list.every(resting) && list.some((b) => srvStrikes.get(b))) await new Promise((r) => setTimeout(r, Math.min(15000, Math.max(200, Math.min(...list.map((b) => srvRest.get(b))) - Date.now()))));
  let order = [...list].sort((a, b) => resting(a) - resting(b));
  // block data is public and identical everywhere: spread it over all servers to double the speed
  if (/^block(-height)?\//.test(path)) { const up = order.filter((b) => !resting(b)); if (up.length > 1) { const k = srvRR++ % up.length; order = [...up.slice(k), ...up.slice(0, k), ...order.filter(resting)]; } }
  let last = null, lastErr = null;
  for (const base of order) {
    const mempoolOnly = /^v1\//.test(path) && !/mempool\.space/.test(base) && !customServer();
    try {
      if (mempoolOnly && path.startsWith('v1/fees/recommended')) {
        // Blockstream has /fee-estimates instead: map it to the same shape
        const r = await timedFetch(base + 'fee-estimates', init);
        if (r.ok) { const f = await r.json(); return new Response(JSON.stringify({ fastestFee: f['1'] || f['2'], halfHourFee: f['3'] || f['2'], hourFee: f['6'] || f['3'] }), { status: 200 }); }
        last = r; srvRest.set(base, Date.now() + 30000); continue;
      }
      if (mempoolOnly) { last = new Response('not supported', { status: 404 }); continue; }
      const r = await timedFetch(base + path, init);
      // 429 = rate limit; Blockstream also answers 403 once its hourly per-IP cap is hit
      if (r.status === 429 || r.status === 403 || r.status >= 500) {
        const k = (srvStrikes.get(base) || 0) + 1; srvStrikes.set(base, k);
        srvRest.set(base, Date.now() + (r.status === 403 ? 600000 : Math.min(30000, 1000 * 2 ** k))); last = r; // 2 s, 4 s, 8 s … up to 30 s (10 min for an hourly cap)
        if (r.status === 429) { scanCtl.conc = Math.max(2, Math.floor(scanCtl.conc / 2)); scanCtl.ok = 0; }
        continue;
      }
      srvStrikes.delete(base);
      if (/^block\//.test(path) && ++scanCtl.ok >= 30) { scanCtl.ok = 0; scanCtl.conc = Math.min(24, scanCtl.conc + 1); }
      state.server = base;
      return r;
    } catch (e) { srvRest.set(base, Date.now() + 10000); lastErr = e; }
  }
  if (last) return last;
  throw lastErr || new Error('No server reachable');
}
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url;
  if (typeof url === 'string' && typeof state !== 'undefined' && state.net) {
    const base = serverList().find((b) => url.startsWith(b));
    if (base) return viaServers(url.slice(base.length), init);
  }
  return timedFetch(input, init);
};
const { b2n, n2b, mulG, Point } = util;
const b58c = createBase58check(sha256);
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (h, n = 10) => (h.length > n * 2 + 1 ? h.slice(0, n) + '…' + h.slice(-n) : h);
const fmtSats = (s) => (s == null ? '—' : (s / 1e8).toFixed(8).replace(/\B(?=(\d{3})+(?!\d)\.)/g, ' '));

const NETS = {
  main: { name: 'Mainnet', sp: 'sp', tr: 'bc', coin: 0, wif: 0x80, mempool: 'https://mempool.space/api/tx/' },
  signet: { name: 'Signet', sp: 'tsp', tr: 'tb', coin: 1, wif: 0xef, mempool: 'https://mempool.space/signet/api/tx/' },
};

const state = {
  net: 'main', // MASKED supports Mainnet and Signet
  wallet: null,
  labels: [{ m: 1, note: 'Donations' }],
  coins: [],
  fundingCoins: [],
  scanLog: [],
  tab: 'receive',
  sendResult: null,
  mintResult: null,
  scanProgress: null,
  fundingMsg: null,
};
const net = () => NETS[state.net];
const walletId = () => state.wallet ? `${state.net}:${state.wallet.Bscan.toHex(true)}:${state.wallet.Bspend.toHex(true)}` : `${state.net}:none`;
const scanStoreKey = () => `wren.scan.${walletId()}`;
function loadScanProgress() {
  try { state.scanProgress = JSON.parse(localStorage.getItem(scanStoreKey()) || 'null'); }
  catch { state.scanProgress = null; }
}
function saveScanProgress(progress) {
  state.scanProgress = progress;
  try { localStorage.setItem(scanStoreKey(), JSON.stringify(progress)); } catch {}
}

// ---------- wallet ----------
function walletFromKeys(bScan, spendKeyBytes, source, extra = {}) {
  let bSpend = null, Bspend;
  if (spendKeyBytes.length === 32) { bSpend = util.mod(b2n(spendKeyBytes)); Bspend = mulG(bSpend); }
  else Bspend = Point.fromHex(spendKeyBytes);
  bScan = util.mod(bScan);
  if (bScan === 0n || (bSpend !== null && bSpend === 0n)) throw new Error('Key is zero');
  const wallet = { source, bScan, bSpend, Bscan: mulG(bScan), Bspend, ...extra };
  if (!wallet.fundingPriv && bSpend !== null) wallet.fundingPriv = toHex(n2b(bSpend));
  return wallet;
}
function walletFromMnemonic(words, passphrase = '') {
  const seed = mnemonicToSeedSync(words, passphrase);
  const root = HDKey.fromMasterSeed(seed);
  const c = net().coin;
  const scan = root.derive(`m/352'/${c}'/0'/1'/0`).privateKey;
  const spend = root.derive(`m/352'/${c}'/0'/0'/0`).privateKey;
  const funding = root.derive(`m/86'/${c}'/0'/0/0`).privateKey;
  return walletFromKeys(b2n(scan), spend, 'mnemonic', { mnemonic: words, passphrase, fundingPriv: toHex(funding) });
}
function saveLocalWallet() {
  // The recovery phrase is only ever stored inside the encrypted vault (see sealVault). Here we just remember the network.
  try { localStorage.setItem('wren.net', state.net); } catch {}
}
function loadExample() {
  state.net = 'signet';
  state.wallet = walletFromKeys(b2n(fromHex(EXAMPLE.keys.scan_priv_key)), fromHex(EXAMPLE.keys.spend_priv_key), 'example');
  state.coins = [];
  state.fundingCoins = [];
  state.scanLog = [];
  loadScanProgress();
}

function address(m = null) {
  const w = state.wallet;
  const B = m === null ? w.Bspend : sp.labeledSpend(w.Bspend, w.bScan, m);
  return sp.encodeAddress(w.Bscan, B, state.net === 'main' ? 'main' : 'test');
}
function trAddress(xHex) {
  return bech32m.encode(net().tr, [1, ...bech32m.toWords(fromHex(xHex))]);
}
function keySpendTaproot(privHex) {
  const internalPriv = normalizeSchnorrPriv(privHex);
  const internalPoint = mulG(b2n(internalPriv));
  const internalX = xonly(internalPoint);
  const tweak = tapTweak(internalX);
  const outputPoint = internalPoint.add(mulG(tweak));
  const parity = hasOddY(outputPoint) ? 1 : 0;
  let outputPriv = util.mod(b2n(internalPriv) + tweak);
  if (parity) outputPriv = secp256k1.CURVE.n - outputPriv;
  return { internalX: toHex(internalX), outputX: toHex(xonly(outputPoint)), outputPriv: toHex(n2b(outputPriv)), address: trAddress(toHex(xonly(outputPoint))) };
}
function fundingInfo() {
  if (!state.wallet?.fundingPriv) return null;
  return keySpendTaproot(state.wallet.fundingPriv);
}
function mempoolAddressUrl(address) {
  const base = net().mempool.replace(/\/api\/tx\/?$/, '');
  return `${base}/address/${address}`;
}
function ordinalAddressUrl(address) {
  return `${DEFAULT_INDEXER[state.net]}/address/${address}`;
}
function toWif(hex) {
  return b58c.encode(Uint8Array.from([net().wif, ...fromHex(hex), 1]));
}
function parsePriv(s) {
  s = s.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  try {
    const b = b58c.decode(s);
    if ((b.length === 34 && b[33] === 1) || b.length === 33) return toHex(b.slice(1, 33));
  } catch {}
  throw new Error('Private key must be 64 hex characters or a WIF key');
}

// ---------- ordinal / BRC-20 minting ----------
const OP = { FALSE: 0x00, IF: 0x63, ENDIF: 0x68, CHECKSIG: 0xac };
const TAPROOT_ANNEX_PREFIX = 0x50;
const TAP_LEAF_VERSION = 0xc0;
const DEFAULT_REVEAL_VALUE = 330; // every inscription (mint, deploy, reservation) carries 330 sats: the taproot dust limit
const TRANSFER_POSTAGE = 330; // taproot dust limit: transfer inscriptions carry 330 sats (like UniSat)
const DUST_CHANGE = 330;
const DEFAULT_BROADCAST = {
  main: 'https://mempool.space/api/tx',
  signet: 'https://mempool.space/signet/api/tx',
};
const DEFAULT_INDEXER = {
  main: 'https://ordinals.com',
  signet: 'https://signet.ordinals.com',
};
const enc = new TextEncoder();
const ZERO32 = new Uint8Array(32);
const u8 = (n) => Uint8Array.from([n]);
const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64le = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const rev = (b) => Uint8Array.from(b).reverse();
const varint = (n) => n < 0xfd ? u8(n) : n <= 0xffff ? concat(u8(0xfd), u8(n & 255), u8(n >> 8)) : concat(u8(0xfe), u32le(n));
const push = (b) => b.length === 0 ? u8(0) : b.length <= 75 ? concat(u8(b.length), b) : b.length <= 255 ? concat(u8(76), u8(b.length), b) : concat(u8(77), u8(b.length & 255), u8(b.length >> 8), b);
const tagged = (tag, ...msgs) => sp.taggedHash(tag, ...msgs);
const xonly = (P) => P.toRawBytes(true).slice(1);
const lift = (x) => Point.fromHex(concat(u8(2), x));
const hasOddY = (P) => P.toRawBytes(true)[0] === 3;
const compactSizeLength = (n) => n < 0xfd ? 1 : n <= 0xffff ? 3 : 5;

function normalizeSchnorrPriv(hex) {
  let d = b2n(fromHex(hex));
  if (hasOddY(mulG(d))) d = secp256k1.CURVE.n - d;
  return n2b(d);
}
function p2trScript(xHex) { return concat(u8(0x51), u8(0x20), fromHex(xHex)); }
function txidFromRaw(rawHex) { return toHex(rev(sha256(sha256(fromHex(rawHex))))); }
// txid = hash of the serialization WITHOUT witness data (hashing the full segwit tx gives the wtxid).
function txidOf(tx) { return txidFromRaw(encodeTx({ inputs: tx.inputs, outputs: tx.outputs })); }
function leafHash(script) { return tagged('TapLeaf', u8(TAP_LEAF_VERSION), varint(script.length), script); }
function tapTweak(internalX, merkleRoot = new Uint8Array()) { return b2n(tagged('TapTweak', internalX, merkleRoot)); }
function taprootScriptOutput(internalPrivHex, leafScript) {
  const internalPriv = normalizeSchnorrPriv(internalPrivHex);
  const internalPoint = mulG(b2n(internalPriv));
  const internalX = xonly(internalPoint);
  const lh = leafHash(leafScript);
  const tweak = tapTweak(internalX, lh);
  const outputPoint = internalPoint.add(mulG(tweak));
  const parity = hasOddY(outputPoint) ? 1 : 0;
  let outputPriv = util.mod(b2n(internalPriv) + tweak);
  if (parity) outputPriv = secp256k1.CURVE.n - outputPriv;
  return { internalPriv, internalX, leafHash: lh, outputPriv: toHex(n2b(outputPriv)), outputX: toHex(xonly(outputPoint)), controlBlock: concat(u8(TAP_LEAF_VERSION | parity), internalX) };
}
function isSilentAddress(address) {
  try {
    const d = sp.decodeAddress(address);
    return (d.network === 'main') === (state.net === 'main');
  } catch { return false; }
}
function encodeAddressScript(address) {
  if (/^(sp|tsp)1/i.test(address)) throw new Error('Silent payment address needs a funding transaction before the output can be derived.');
  const { prefix, words } = bech32m.decode(address.toLowerCase());
  if (prefix !== net().tr) throw new Error(`Recipient address must use ${net().tr}… for ${net().name}.`);
  const version = words[0];
  const data = Uint8Array.from(bech32m.fromWords(words.slice(1)));
  if (version === 0 && data.length === 20) return concat(u8(0x00), u8(0x14), data);
  if (version === 0 && data.length === 32) return concat(u8(0x00), u8(0x20), data);
  if (version === 1 && data.length === 32) return concat(u8(0x51), u8(0x20), data);
  throw new Error('Unsupported recipient address type.');
}
// RBF on (default): inputs signal replace-by-fee, so a stuck transaction can be sped up later
let RBF = true;
try { RBF = localStorage.getItem('wren.rbf') !== '0'; } catch {}
const inSeq = (i) => i.sequence ?? (RBF ? 0xfffffffd : 0xffffffff);
function encodeTx({ inputs, outputs, witnesses = [] }) {
  const hasWitness = witnesses.some((w) => w?.length);
  const vin = inputs.map((i) => concat(rev(fromHex(i.txid)), u32le(i.vout), varint(i.script?.length || 0), i.script || new Uint8Array(), u32le(inSeq(i))));
  const vout = outputs.map((o) => concat(u64le(o.value), varint(o.script.length), o.script));
  const base = concat(u32le(2), hasWitness ? u8(0) : new Uint8Array(), hasWitness ? u8(1) : new Uint8Array(), varint(inputs.length), ...vin, varint(outputs.length), ...vout);
  const wit = hasWitness ? concat(...inputs.map((_, i) => {
    const stack = witnesses[i] || [];
    return concat(varint(stack.length), ...stack.map((x) => concat(varint(x.length), x)));
  })) : new Uint8Array();
  return toHex(concat(base, wit, u32le(0)));
}
function taprootSighash({ inputs, outputs, inputIndex, scriptPath = null }) {
  const prevouts = concat(...inputs.map((i) => concat(rev(fromHex(i.txid)), u32le(i.vout))));
  const amounts = concat(...inputs.map((i) => u64le(i.value)));
  const scriptPubKeys = concat(...inputs.map((i) => concat(varint(i.scriptPubKey.length), i.scriptPubKey)));
  const sequences = concat(...inputs.map((i) => u32le(inSeq(i))));
  const outs = concat(...outputs.map((o) => concat(u64le(o.value), varint(o.script.length), o.script)));
  const extFlag = scriptPath ? 1 : 0;
  const spendType = extFlag * 2;
  const common = concat(
    u8(0), u32le(2), u32le(0), sha256(prevouts), sha256(amounts),
    sha256(scriptPubKeys), sha256(sequences), sha256(outs), u8(spendType), u32le(inputIndex),
  );
  const ext = scriptPath ? concat(scriptPath.leafHash, u8(0), u32le(0xffffffff)) : new Uint8Array();
  return tagged('TapSighash', u8(0), common, ext);
}
async function signTaprootKeySpend(tx, inputIndex, privHex) {
  const sig = await schnorr.sign(taprootSighash({ ...tx, inputIndex }), normalizeSchnorrPriv(privHex));
  return sig;
}
async function signTaprootScriptSpend(tx, inputIndex, priv, leafHashBytes) {
  const sig = await schnorr.sign(taprootSighash({ ...tx, inputIndex, scriptPath: { leafHash: leafHashBytes } }), priv);
  return sig;
}
function inscriptionScript(pubkeyX, contentType, body, parent = null) {
  const chunks = [];
  for (let i = 0; i < body.length; i += 520) chunks.push(push(body.slice(i, i + 520)));
  return concat(
    push(pubkeyX), u8(OP.CHECKSIG), u8(OP.FALSE), u8(OP.IF),
    push(enc.encode('ord')), push(u8(1)), push(enc.encode(contentType)),
    ...(parent ? [push(u8(3)), push(parent)] : []),
    push(new Uint8Array()), ...chunks, u8(OP.ENDIF),
  );
}
function brc20MintBody(tick, amount) {
  return enc.encode(JSON.stringify({ p: 'brc-20', op: 'mint', tick, amt: amount }));
}
function estimateOrdinalMint({ inputValue, feeRate, bodyLength }) {
  const bodyChunks = Math.ceil(bodyLength / 520) || 1;
  const commitVbytes = 10.5 + 57.5 + 43 + 43;
  const revealWitnessWeight = 64 + compactSizeLength(bodyLength) + bodyLength + 65;
  const revealVbytes = 10.5 + 57.5 + 43 + revealWitnessWeight / 4 + bodyChunks;
  const commitFee = Math.ceil(commitVbytes * feeRate);
  const revealFee = Math.ceil(revealVbytes * feeRate);
  const revealValue = DEFAULT_REVEAL_VALUE;
  const change = inputValue - revealValue - commitFee - revealFee;
  return { commitVbytes, revealVbytes, commitFee, revealFee, revealValue, change, totalFee: commitFee + revealFee };
}
const satsFromInput = (s) => {
  const raw = String(s || '').trim();
  if (!raw) throw new Error('Enter an amount.');
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!/^\d+(\.\d{1,8})?$/.test(raw)) throw new Error('Amount must be sats or BTC, for example 10000 or 0.0001.');
  const [whole, frac = ''] = raw.split('.');
  return Number(BigInt(whole) * 100000000n + BigInt(frac.padEnd(8, '0')));
};
function estimateSimpleSend({ outputs, feeRate }) {
  return Math.ceil((10.5 + 57.5 + outputs * 43) * feeRate);
}

async function broadcastHex(url, hex) {
  const res = await fetch(url, { method: 'POST', body: hex });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `Broadcast failed with HTTP ${res.status}`);
  return text.trim();
}
// ---------- scanning ----------
function normTx(t) {
  if (!t || !Array.isArray(t.vin) || !Array.isArray(t.vout)) throw new Error('Each transaction needs vin and vout arrays');
  const esplora = t.vout.some((o) => 'scriptpubkey' in o);
  const vin = t.vin.map((v) => ({
    txid: v.txid, vout: v.vout,
    coinbase: !!(v.is_coinbase || v.coinbase),
    scriptSig: v.scriptsig ?? v.scriptSig?.hex ?? '',
    witness: (v.witness ?? v.txinwitness ?? []).map((h) => fromHex(h)),
    prevoutScript: v.prevout?.scriptpubkey ?? v.prevout?.scriptPubKey?.hex,
  }));
  const vout = t.vout.map((o, i) => ({
    n: o.n ?? i,
    spk: (o.scriptpubkey ?? o.scriptPubKey?.hex ?? '').toLowerCase(),
    sats: esplora ? o.value : o.value != null ? Math.round(o.value * 1e8) : null,
  }));
  return { txid: t.txid ?? t.hash ?? '(no txid)', vin, vout };
}
function extractTxs(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.tx)) return json.tx; // Core getblock <hash> 3
  if (json && json.result) return extractTxs(json.result);
  return [json];
}


// =====================================================================
// Wallet UI: Public balance (normal taproot address) + Shielded balance
// (BIP 352 silent payments). Everything below is presentation + flows.
// =====================================================================

// Coins at or below this size are treated as carrying an inscription
// (ordinal / BRC-20) and are never picked automatically for sends.
const INSCRIPTION_MAX = 1000;

const unit = () => (state.net === 'main' ? 'BTC' : 'tBTC');
const isTest = () => state.net !== 'main';
const fmtBtc = (s) => {
  if (s == null) return '0';
  const v = (s / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  return v === '' ? '0' : v;
};
const sum = (list) => list.reduce((a, c) => a + (c.sats || 0), 0);
const canSign = () => !!state.wallet && state.wallet.bSpend !== null;
// Coins that hold (or may hold) an inscription are never picked for sends, fees, commits or anchors.
const lockKey = () => `wren.locks.${walletId()}`;
function locks() { try { return new Set(JSON.parse(localStorage.getItem(lockKey()) || '[]')); } catch { return new Set(); } }
function toggleLock(op) { const l = locks(); l.has(op) ? l.delete(op) : l.add(op); try { localStorage.setItem(lockKey(), JSON.stringify([...l])); } catch {} }
function autoProtected(c) { if (c.sats != null && c.sats <= INSCRIPTION_MAX) return true; const o = ordOf(c); if (o && (o.ins || o.runes)) return true; const i = inscOf(c); return !!i && !i.unknown; }
// ord check: inscriptions or runes can sit on a coin of ANY size, so bigger coins are checked with ord
// (ordinals.com) before they can be spent. Results are cached: a coin's contents never change.
const ordKey = () => `wren.ord.${state.net}`;
const ordFail = new Map(); // outpoint -> do not retry before (ms)
let ordMem = null;
function ordCache() { if (!ordMem || ordMem.net !== state.net) { let m = {}; try { m = JSON.parse(localStorage.getItem(ordKey()) || '{}'); } catch {} ordMem = { net: state.net, m }; } return ordMem.m; }
function setOrd(op, v) { const m = ordCache(); m[op] = v; try { localStorage.setItem(ordKey(), JSON.stringify(m)); } catch {} }
const ordOf = (c) => ordCache()[`${c.txid}:${c.vout}`] || null;
const needsOrd = (c) => c.sats != null && c.sats > INSCRIPTION_MAX && !c.example;
/** On mainnet an unchecked big coin is not spent until ord has confirmed it is plain bitcoin. */
const unverified = (c) => state.net === 'main' && needsOrd(c) && !ordOf(c);
async function checkOrd(list = [...state.fundingCoins, ...state.coins], waitMs = 9000) {
  let todo = list.filter((c) => needsOrd(c) && !ordOf(c) && !c.pending && (ordFail.get(`${state.net}:${c.txid}:${c.vout}`) || 0) < Date.now());
  if (!todo.length) return;
  const save = (op, j) => { const runes = Array.isArray(j.runes) ? j.runes.length : j.runes ? Object.keys(j.runes).length : 0; setOrd(op, { ins: (j.inscriptions || []).length, runes, at: Date.now() }); };
  // ord answers many outputs in one request (POST /outputs); one request per coin is the fallback
  for (let i = 0; i < todo.length && i < 400; i += 100) {
    const part = todo.slice(i, i + 100), ops = part.map((c) => `${c.txid}:${c.vout}`);
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await rawFetch(`${DEFAULT_INDEXER[state.net]}/outputs`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(ops), signal: ctl.signal });
      if (!r.ok) break;
      const arr = await r.json();
      if (!Array.isArray(arr) || arr.length !== ops.length) break;
      arr.forEach((j, k) => { const op = j?.outpoint || ops[k]; if (j && j.indexed !== false && ops.includes(op)) save(op, j); });
    } catch { break; } finally { clearTimeout(t); }
  }
  todo = todo.filter((c) => !ordOf(c)).slice(0, 60);
  if (!todo.length) return;
  const one = async (c) => {
    const op = `${c.txid}:${c.vout}`;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await rawFetch(`${DEFAULT_INDEXER[state.net]}/output/${op}`, { headers: { Accept: 'application/json' }, signal: ctl.signal });
      if (!r.ok) { ordFail.set(`${state.net}:${op}`, Date.now() + 60000); return; }
      const j = await r.json();
      if (j.indexed === false) return; // ord has not reached this block yet
      save(op, j);
    } catch { ordFail.set(`${state.net}:${op}`, Date.now() + 60000); } finally { clearTimeout(t); }
  };
  const run = (async () => { for (let i = 0; i < todo.length; i += 8) await Promise.all(todo.slice(i, i + 8).map(one)); })();
  await Promise.race([run, new Promise((r) => setTimeout(r, waitMs))]);
}
/** Called before building anything that spends coins. */
async function ensureOrd(from) {
  const pool = from === 'shielded' ? state.coins : from === 'public' ? state.fundingCoins : from === 'trade' ? (state.tradeCoins || []) : [...state.fundingCoins, ...state.coins];
  if (state.net !== 'main') { checkOrd(pool); return; } // test networks: check in the background, never block
  await checkOrd(pool);
  if (state.net === 'main' && !coinsFor(from || 'public').length && pool.some(unverified))
    throw new Error('Checking your coins for inscriptions with ord… try again in a few seconds. (ordinals.com did not answer.)');
}
const isProtected = (c) => autoProtected(c) || locks().has(`${c.txid}:${c.vout}`);
const publicCoins = () => (canSign() ? state.fundingCoins.filter((c) => c.sats != null && !isProtected(c) && !unverified(c)) : []);
const shieldedCoins = () => (canSign() ? state.coins.filter((c) => !c.example && c.sats != null && !isProtected(c) && !unverified(c)) : []);
const coinsFor = (from) => (from === 'shielded' ? shieldedCoins() : from === 'trade' ? tradeCoinsFor() : publicCoins());
/** "Public · 0.0017" for the pay-from pickers; while ord is still checking big coins it says so (and checks). */
function spendLabel(from) {
  const n = sum(coinsFor(from));
  const pool = from === 'shielded' ? state.coins : state.fundingCoins;
  if (!n && pool.some(unverified)) {
    if (!state.ordBusy && Date.now() - (state.ordAt || 0) > 15000) { state.ordBusy = true; state.ordAt = Date.now(); checkOrd(pool, 20000).finally(() => { state.ordBusy = false; render(); }); }
    return '…';
  }
  if (!n && from === 'public' && sum(state.fundingCoins)) return '0 free'; // every coin holds an inscription
  return fmtBtc(n);
}
const pubAddr = () => fundingInfo()?.address || '';
const shieldAddr = () => (state.wallet ? address() : '');
function mempoolTxUrl(txid) { return `${net().mempool.replace(/\/api\/tx\/?$/, '')}/tx/${txid}`; }

function parseBtc(s) {
  const raw = String(s || '').trim().replace(',', '.');
  if (!raw) throw new Error('Enter an amount.');
  if (!/^\d*(\.\d{0,8})?$/.test(raw) || raw === '.') throw new Error(`Enter the amount in ${unit()}, e.g. 0.0001`);
  const [whole = '0', frac = ''] = raw.split('.');
  return Number(BigInt(whole || '0') * 100000000n + BigInt(frac.padEnd(8, '0')));
}

/** What kind of address is this, for the current network? */
function addrKind(a) {
  a = String(a || '').trim();
  if (!a) return { kind: 'empty' };
  if (/^t?sp1/i.test(a)) {
    try {
      const d = sp.decodeAddress(a);
      if ((d.network === 'main') !== (state.net === 'main')) return { kind: 'wrongnet', text: `This is a ${d.network === 'main' ? 'Mainnet' : 'Signet'} address` };
      return { kind: 'shielded', text: 'Shielded address · private' };
    } catch { return { kind: 'invalid', text: 'Not a valid address' }; }
  }
  try {
    const { prefix } = bech32m.decode(a.toLowerCase());
    if (prefix !== net().tr) return { kind: 'wrongnet', text: `This is a ${prefix === 'bc' ? 'Mainnet' : 'test network'} address` };
    encodeAddressScript(a);
    return { kind: 'public', text: 'Public address · visible on-chain' };
  } catch {}
  try {
    // bech32 (v0, bc1q / tb1q)
    const { prefix, words } = bech32.decode(a.toLowerCase());
    if (prefix !== net().tr) return { kind: 'wrongnet', text: `This is a ${prefix === 'bc' ? 'Mainnet' : 'test network'} address` };
    if (words[0] === 0) return { kind: 'public', text: 'Public address · visible on-chain' };
  } catch {}
  return { kind: 'invalid', text: 'Not a valid address' };
}
function outputScriptFor(a) {
  try { return encodeAddressScript(a); } catch {}
  const { prefix, words } = bech32.decode(a.toLowerCase());
  if (prefix !== net().tr || words[0] !== 0) throw new Error('Unsupported address.');
  const data = Uint8Array.from(bech32.fromWords(words.slice(1)));
  if (data.length === 20) return concat(u8(0x00), u8(0x14), data);
  if (data.length === 32) return concat(u8(0x00), u8(0x20), data);
  throw new Error('Unsupported address.');
}

// ---------- persistence for found coins ----------
const coinStoreKey = () => `wren.coins.${walletId()}`;
function saveCoins() {
  try { localStorage.setItem(coinStoreKey(), JSON.stringify(state.coins.filter((c) => !c.example))); } catch {}
}
function loadCoins() {
  try { state.coins = JSON.parse(localStorage.getItem(coinStoreKey()) || '[]'); } catch { state.coins = []; }
  loadFunding();
  state.idxW = undefined;
}

// ---------- fees ----------
const r2 = (x) => Math.round(x * 100) / 100;
async function fetchFees() {
  // mempool.space's precise endpoint has sub-1 sat/vB rates; other servers fall back to whole numbers
  let j = null;
  try { const r = await fetch(`${esploraBase()}v1/fees/precise`); if (r.ok) { const x = await r.json(); if (x && x.fastestFee > 0) j = x; } } catch {}
  if (!j) j = await readJson(await fetch(`${esploraBase()}v1/fees/recommended`), 'Fee lookup');
  const minimum = Math.max(0.1, Number(j.minimumFee) || 0.1);
  const half = Number(j.halfHourFee) || Number(j.hourFee) || 1, hour = Number(j.hourFee) || half;
  const slow = r2(Math.max(minimum, half < 1 ? half : hour));
  const normal = Math.max(slow, half >= 1 ? Math.round(half) : 1);
  const fast = Math.max(normal, Math.ceil(Number(j.fastestFee) || normal));
  state.fees = { slow, normal, fast };
}
const FEE_MIN = 0.1, FEE_MAX = 2000;
const customFee = () => { const v = Number(String(state.f.feeCustom || '').replace(',', '.')); return v >= FEE_MIN && v <= FEE_MAX ? r2(v) : 0; };
const feeRate = () => (state.f.fee === 'custom' ? customFee() || state.fees.normal : state.fees[state.f.fee] || state.fees.normal);
const fmtRate = (r) => (r < 10 ? String(r2(r)) : String(Math.round(r)));
async function fetchPrice() {
  if (state.net !== 'main') { state.usd = null; return; }
  if (state.usdAt && Date.now() - state.usdAt < 5 * 60000) return;
  try { const r = await fetch(`${esploraBase()}v1/prices`); if (r.ok) { const j = await r.json(); if (j.USD > 0) { state.usd = j.USD; state.usdAt = Date.now(); } } } catch {}
}
const usdOf = (sats) => (state.net === 'main' && state.usd ? `$${((sats / 1e8) * state.usd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '');

// ---------- chain sync ----------
async function fetchTipHeight() {
  const res = await fetch(`${esploraBase()}blocks/tip/height`);
  if (!res.ok) throw new Error(`Could not reach ${new URL(esploraBase()).host}.`);
  return Number(await res.text());
}
async function readJson(res, label) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} failed (${res.status}).`);
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} returned an unexpected reply.`); }
}
async function fetchBlockHash(height) {
  const res = await fetchRetry(`${esploraBase()}block-height/${height}`, `Block ${height}`);
  return (await res.text()).trim();
}
async function syncFundingCoins() {
  const f = fundingInfo();
  if (!f) return [];
  const res = await fetch(`${esploraBase()}address/${f.address}/utxo`);
  const utxos = await readJson(res, 'Balance lookup');
  if (!Array.isArray(utxos)) throw new Error('Balance lookup returned an unexpected reply.');
  state.fundingCoins = utxos.map((u) => ({
    key: `fund:${u.txid}:${u.vout}`, kind: 'funding', txid: u.txid, vout: u.vout, sats: u.value,
    output: f.outputX, privKey: f.outputPriv, address: f.address, pending: !u.status?.confirmed,
  }));
  state.fundAt = Date.now();
  saveFunding();
  return state.fundingCoins;
}
// last known Public coins, so the balance shows the moment the wallet opens (refreshed right after)
const fundStoreKey = () => `wren.fund.${walletId()}`;
function saveFunding() {
  try { localStorage.setItem(fundStoreKey(), JSON.stringify(state.fundingCoins.map(({ privKey, ...c }) => c))); } catch {}
}
function loadFunding() {
  state.fundAt = 0;
  const f = fundingInfo();
  try {
    const list = JSON.parse(localStorage.getItem(fundStoreKey()) || '[]');
    state.fundingCoins = f ? list.filter((c) => c.address === f.address).map((c) => ({ ...c, output: f.outputX, privKey: f.outputPriv })) : [];
  } catch { state.fundingCoins = []; }
}
function scanTx(raw, { pending = false } = {}) {
  const tx = normTx(raw);
  if (tx.vin.some((v) => v.coinbase)) return { txid: tx.txid, status: 'skip', why: 'Coinbase transaction' };
  const trOuts = tx.vout.filter((o) => o.spk.length === 68 && o.spk.startsWith('5120'));
  if (!trOuts.length) return { txid: tx.txid, status: 'skip', why: 'No taproot outputs' };
  if (tx.vin.some((v) => v.prevoutScript == null))
    throw new Error(`Transaction ${short(tx.txid, 8)} has no prevout scripts. Use mempool.space API JSON or Bitcoin Core "getrawtransaction <txid> 2".`);
  const pubs = tx.vin.map((v) => sp.inputPubKey(v)).filter(Boolean).map((r) => r.pub);
  const tweak = sp.txTweak(pubs, tx.vin.map((v) => ({ txid: v.txid, vout: v.vout })));
  if (!tweak) return { txid: tx.txid, status: 'skip', why: 'No eligible inputs' };
  const w = state.wallet;
  const found = scanFor(tweak.toRawBytes(true), trOuts.map((o) => o.spk.slice(4)));
  for (const f of found) {
    const o = trOuts.find((x) => x.spk.slice(4) === f.output);
    const key = `${tx.txid}:${o.n}`;
    const have = state.coins.find((c) => c.key === key);
    if (have) { if (!pending) have.pending = false; continue; }
    state.coins.push({ key, txid: tx.txid, vout: o.n, sats: o.sats, output: f.output, tweak: f.tweak, label: f.label, example: w.source === 'example', pending });
  }
  return { txid: tx.txid, status: found.length ? 'hit' : 'miss', n: found.length, why: found.length ? '' : 'Nothing for this wallet' };
}
// ---------- the private check (scan key never leaves this browser) ----------
let labelMemo = null;
function scanLabels() {
  const w = state.wallet, ms = [0, ...state.labels.map((l) => l.m)];
  const key = `${w.Bscan.toHex(true)}:${ms.join(',')}`;
  if (labelMemo?.key !== key) labelMemo = { key, map: sp.buildLabels(w.bScan, ms), bScan32: n2b(w.bScan), Bspend33: w.Bspend.toRawBytes(true) };
  return labelMemo;
}
/** BIP 352 check of one transaction's taproot outputs: WebAssembly libsecp256k1 when available, pure JS otherwise. */
function scanFor(tweak33, outputs) {
  const L = scanLabels(), w = state.wallet;
  return fastReady() ? fastScanOutputs(tweak33, outputs, L.bScan32, L.Bspend33, L.map) : sp.scanOutputs(Point.fromHex(tweak33), outputs, w.bScan, w.Bspend, L.map);
}
initFast(SECP_WASM).then((ok) => { state.fastCrypto = ok; });
// ---------- multi-core: split big blocks over background workers (one per CPU core) ----------
const pool = { workers: [], ok: null, seq: 0, jobs: new Map(), keyed: null };
function poolUp() {
  if (pool.ok !== null) return pool.ok;
  pool.ok = false;
  if ((!hasExt() && !isApp()) || typeof Worker === 'undefined') return false;
  try {
    const n = Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker('scan-worker.js');
      w.onmessage = (e) => { const j = pool.jobs.get(e.data.id); if (j) { pool.jobs.delete(e.data.id); e.data.error ? j.reject(new Error(e.data.error)) : j.resolve(e.data.out); } };
      w.onerror = () => { pool.ok = false; for (const j of pool.jobs.values()) j.reject(new Error('worker failed')); pool.jobs.clear(); };
      pool.workers.push(w);
    }
    pool.ok = true;
  } catch { pool.ok = false; }
  return pool.ok;
}
/** items: [[tweakHex, [xonlyHex…]], …] → Map(index → found[]). Falls back to this thread if workers are unavailable. */
async function scanMany(items) {
  const res = new Map();
  if (items.length >= 64 && poolUp()) {
    const L = scanLabels();
    if (pool.keyed !== L.key) {
      const msg = { type: 'keys', bScan32: L.bScan32, Bspend33: L.Bspend33, bScanHex: state.wallet.bScan.toString(16), labels: [...L.map].map(([hex, l]) => [hex, l.m, l.tweak.toString(16)]) };
      for (const w of pool.workers) w.postMessage(msg);
      pool.keyed = L.key;
    }
    const per = Math.ceil(items.length / pool.workers.length);
    try {
      await Promise.all(pool.workers.map((w, k) => {
        const part = items.slice(k * per, (k + 1) * per); if (!part.length) return null;
        const id = ++pool.seq;
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => { pool.jobs.delete(id); pool.ok = false; reject(new Error('worker timeout')); }, 20000);
          pool.jobs.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
          w.postMessage({ type: 'scan', id, items: part });
        })
          .then((out) => { for (const [i, f] of out) res.set(k * per + i, f); });
      }));
      return res;
    } catch { res.clear(); /* fall through to this thread */ }
  }
  items.forEach(([tw, outs], i) => { const f = scanFor(fromHex(tw), outs); if (f.length) res.set(i, f); });
  return res;
}
// ---------- scan server (optional): precomputed public data per block (default: scan.maskedwallet.com) ----------
const scanKey = () => `wren.scansrv.${state.net}`;
// MASKED's own scan server is on by default for Mainnet (Settings → Turn off stores "off")
const DEFAULT_SCAN = { main: 'https://scan.maskedwallet.com' };
function scanServer() {
  let v = null; try { v = localStorage.getItem(scanKey()); } catch {}
  if (v === 'off') return '';
  return v || DEFAULT_SCAN[state.net] || '';
}
const SCAN_NETS = { main: 'main', signet: 'signet' };
const scanInfo = { at: 0, data: null };
async function scanServerInfo(force = false) {
  const u = scanServer(); if (!u) return null;
  if (!force && scanInfo.url === u && Date.now() - scanInfo.at < 60000) return scanInfo.data;
  try { const r = await timedFetch(`${u}/v1/info`); scanInfo.data = r.ok ? await r.json() : null; } catch { scanInfo.data = null; }
  scanInfo.at = Date.now(); scanInfo.url = u;
  return scanInfo.data;
}
/** Scan one block from the scan server. Returns null if the server can't help (wallet then scans normally). */
async function scanBlockFromServer(height, { cut = false } = {}) {
  const info = await scanServerInfo();
  if (!info || info.network !== SCAN_NETS[state.net] || height < info.start || height > info.height) return null;
  let j;
  // restoring history: ask only for outputs nobody has spent yet (what the balance needs)
  const q = cut && info.cutThrough ? '?unspent=1' : '';
  const down = () => { scanInfo.data = null; scanInfo.at = Date.now(); scanInfo.url = scanServer(); return null; };
  try { const r = await timedFetch(`${scanServer()}/v1/block/${height}${q}`); if (!r.ok) return r.status === 404 ? null : down(); j = await r.json(); } catch { return down(); }
  if (j.h !== height || !Array.isArray(j.txs)) return null;
  let hits = 0;
  let foundAll;
  try { foundAll = await scanMany(j.txs.map(([, tw, outs]) => [tw, outs.map((o) => o[1])])); } catch { return null; }
  for (const [idx, found] of foundAll) {
    const [txid, , outs] = j.txs[idx];
    for (const f of found) {
      const o = outs.find((x) => x[1] === f.output);
      const key = `${txid}:${o[0]}`;
      if (state.coins.some((c) => c.key === key)) continue;
      state.coins.push({ key, txid, vout: o[0], sats: o[2], output: f.output, tweak: f.tweak, label: f.label, example: false, pending: false });
      hits++;
    }
  }
  state.scanVia = 'server';
  return hits;
}
async function saveScanServer(url) {
  url = String(url || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^/]+/.test(url)) throw new Error('Enter a URL like https://scan.example.com');
  if (url) {
    if (hasExt() && chrome.permissions?.request) {
      const ok = await chrome.permissions.request({ origins: [new URL(url).origin + '/*'] });
      if (!ok) throw new Error('Permission to reach that server was declined.');
    }
    let info = null; try { const r = await timedFetch(`${url}/v1/info`); info = r.ok ? await r.json() : null; } catch {}
    if (!info || info.service !== 'masked-scan') throw new Error('That is not a MASKED scan server (no /v1/info).');
    if (info.network !== SCAN_NETS[state.net]) throw new Error(`That scan server is for ${info.network}, but the wallet is on ${net().name}.`);
  }
  try { url ? localStorage.setItem(scanKey(), url) : DEFAULT_SCAN[state.net] ? localStorage.setItem(scanKey(), 'off') : localStorage.removeItem(scanKey()); } catch {}
  scanInfo.at = 0;
}
async function fetchRetry(url, label, tries = 2) {
  // busy servers (429) get more patience than ones that do not answer at all
  let last, busy = 0, dead = 0;
  while (dead < 2 && busy < tries) {
    try { const r = await fetch(url); if (r.ok) return r; last = new Error(`${label} (${r.status})`); if (r.status === 429) busy++; else dead++; }
    catch (e) { last = e; dead++; }
    await new Promise((res) => setTimeout(res, 600 * (busy + dead)));
  }
  throw last;
}
async function scanBlock(height, opts = {}) {
  if (scanServer()) { const n = await scanBlockFromServer(height, opts); if (n != null) return n; }
  state.scanVia = 'public';
  const hash = await fetchBlockHash(height);
  // Read the tx count first: esplora pages by 25 and returns 404 past the last page
  // (a block with exactly 25·n txs used to break the scan).
  const info = await (await fetchRetry(`${esploraBase()}block/${hash}`, `Block ${height}`)).json();
  const count = Number(info.tx_count) || 0;
  let hits = 0;
  // fetch the 25-tx pages several at a time (spread over the servers), then check each tx locally
  const starts = []; for (let st = 0; st < count; st += 25) starts.push(st);
  let next = 0;
  const worker = async () => {
    while (next < starts.length) {
      const st = starts[next++];
      await scanSlot();
      let txs;
      try { txs = await (await fetchRetry(`${esploraBase()}block/${hash}/txs/${st}`, `Block ${height}`, 5)).json(); }
      finally { scanCtl.busy--; }
      for (const tx of txs) { try { hits += scanTx(tx).n || 0; } catch {} }
    }
  };
  await Promise.all(Array.from({ length: Math.min(starts.length, 16) }, worker));
  return hits;
}
/** All page requests share one limit (scanCtl.conc), which adapts to the servers' rate limits. */
async function scanSlot() { while ((scanCtl.busy || 0) >= scanCtl.conc) await new Promise((r) => setTimeout(r, 25)); scanCtl.busy = (scanCtl.busy || 0) + 1; }
/** Scan several blocks at once (pages from all of them share the servers). */
async function scanBlocks(heights, opts) { await Promise.all(heights.map((h) => scanBlock(h, opts))); }
/** Look at one tx we just broadcast so our own shielded outputs show up immediately. */
async function ingestTx(txid) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`${esploraBase()}tx/${txid}`);
      if (res.ok) { const j = await res.json(); scanTx(j, { pending: !j.status?.confirmed }); saveCoins(); return true; }
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}
async function dropSpentCoins() {
  const keep = [];
  for (const c of state.coins) {
    if (c.example) { keep.push(c); continue; }
    try {
      const res = await fetch(`${esploraBase()}tx/${c.txid}/outspend/${c.vout}`);
      const j = res.ok ? await res.json() : null;
      if (j?.spent) continue;
    } catch {}
    keep.push(c);
  }
  state.coins = keep;
  saveCoins();
}
function syncText() {
  if (state.syncing) return state.syncNote || 'Checking for payments…';
  if (historyLeft()) return `Restoring history · ${historyLeft().toLocaleString()} blocks left`;
  if (state.syncErr) return 'Sync paused · tap to retry';
  if (state.fundErr) return 'Balance not updated · servers busy, tap to retry';
  const p = state.scanProgress;
  if (!p) return 'Not synced yet';
  return `Up to date · block ${(p.topHeight ?? p.tip ?? 0).toLocaleString()}`;
}
/**
 * Scans new blocks first (so fresh payments show up), then works backwards
 * through history. Fresh wallets never need history, so they stop at birth.
 */
async function syncChain(budget = 6, { older = false } = {}) {
  if (!state.wallet || state.syncing) return;
  const gen = (state.syncGen = (state.syncGen || 0) + 1);
  const live = () => gen === state.syncGen;
  const fundDue = !older || Date.now() - (state.fundAt || 0) > 60000; // history loops reuse a fresh balance
  state.syncing = true; state.syncErr = null; state.syncStart = Date.now(); state.syncNote = fundDue ? 'Checking balance…' : 'Checking for payments…'; render();
  try {
    if (fundDue) {
      fetchFees().catch(() => {});
      // the Public balance never waits on (or fails with) the Shielded scan
      try { await syncFundingCoins(); state.fundErr = null; } catch (e) { state.fundErr = e.message; }
      if (!live()) return;
      state.syncNote = 'Checking for payments…'; render(); // show the Public balance right away
    }
    const tip = await fetchTipHeight();
    state.tip = tip;
    const p = { ...(state.scanProgress || {}) };
    if (!Number.isInteger(p.topHeight)) p.topHeight = Number.isInteger(p.tip) ? p.tip : tip;
    if (!Number.isInteger(p.nextHeight)) p.nextHeight = p.topHeight;
    if (!Number.isInteger(p.floor)) p.floor = state.wallet.fresh ? Math.max(0, tip - 2) : state.wallet.birthday ? birthdayHeight(state.wallet.birthday, tip) : 0;
    p.scannedBlocks = p.scannedBlocks || 0;
    // Mainnet restore: the automatic history scan stops where the scan server starts. Older blocks
    // through public servers need 100+ requests each and get rate-limited; Settings → Rescan still does it.
    let holdHistory = state.histHold = false;
    // a restored phrase may have Shielded coins from before the date picked ("Never used" included):
    // with the scan server, look back to its first block once. It takes seconds.
    if (state.net === 'main' && state.wallet.restored && !p.deepDone && scanServer()) {
      const info = await scanServerInfo();
      if (info && info.network === SCAN_NETS.main && Number.isInteger(info.start)) {
        p.deepDone = true;
        if (p.floor > info.start) { p.floor = info.start; if (!Number.isInteger(p.nextHeight) || p.nextHeight < p.floor - 1) p.nextHeight = p.topHeight; }
      }
    }
    if (state.net === 'main' && !p.manual && p.floor > 0 && p.nextHeight >= p.floor) {
      const info = await scanServerInfo();
      const start = info && info.network === SCAN_NETS.main ? info.start : scanServer() ? null : tip - 144;
      if (start == null) holdHistory = state.histHold = true; // scan server unreachable right now: try again next sync
      else if (p.floor < start) p.floor = Math.min(start, p.nextHeight + 1);
    }
    // The scan server is usually a block or two behind the tip for a minute after each block. Wait for it
    // (next sync picks those up) rather than scanning them through public servers: that took minutes.
    const sInfo = scanServer() ? await scanServerInfo() : null;
    const top = sInfo && sInfo.network === SCAN_NETS[state.net] && sInfo.height < tip && tip - sInfo.height <= 12 ? sInfo.height : tip;
    if (top < tip && p.nextHeight > top && p.nextHeight >= p.floor) holdHistory = state.histHold = true;
    let scanned = 0;
    // scan server set but not answering: only a couple of blocks per sync through public servers, so the wallet stays responsive
    const fwdBudget = older ? 0 : scanServer() && !sInfo ? 2 : Math.max(budget, 24);
    const todo = Math.min(fwdBudget, Math.max(0, top - p.topHeight));
    while (!older && p.topHeight < top && scanned < fwdBudget && live()) {
      const n = Math.min(scanServer() ? 6 : 2, top - p.topHeight, fwdBudget - scanned);
      state.syncNote = `Scanning block ${(p.topHeight + 1).toLocaleString()} · ${scanned + 1}/${todo}`; render();
      await scanBlocks(Array.from({ length: n }, (_, i) => p.topHeight + 1 + i));
      p.topHeight += n; p.scannedBlocks += n; scanned += n;
      saveScanProgress({ ...p, updatedAt: Date.now() }); saveCoins(); render();
    }
    const history = p.floor > 0 && p.nextHeight >= p.floor;
    const oldBudget = history ? Math.max(budget, scanServer() ? 240 : 30) : budget;
    while (!holdHistory && p.nextHeight >= p.floor && scanned < oldBudget && live()) {
      state.syncNote = history ? `Restoring history · ${(p.nextHeight - p.floor + 1).toLocaleString()} blocks left` : `Checking older block ${p.nextHeight.toLocaleString()}`; render();
      const n = Math.min(history ? (scanServer() ? 12 : 3) : 1, p.nextHeight - p.floor + 1, oldBudget - scanned);
      await scanBlocks(Array.from({ length: n }, (_, i) => p.nextHeight - i), { cut: history });
      p.nextHeight -= n; p.scannedBlocks += n; scanned += n;
      saveScanProgress({ ...p, updatedAt: Date.now() }); saveCoins(); render();
    }
    saveScanProgress({ ...p, updatedAt: Date.now() });
  } catch (err) {
    if (live()) state.syncErr = /timeout/i.test(err.message) ? 'The blockchain servers are not responding. Will retry.' : /fetch|network/i.test(err.message) ? 'Could not reach the network.' : `Scan paused: ${err.message}. Will retry.`;
  } finally {
    if (!live()) return; // a newer sync took over (watchdog)
    // These never depend on the block scan succeeding.
    // (history loops skip them while the balance is fresh: fewer requests, less rate-limiting)
    if (fundDue) for (const step of [syncHolders, dropSpentCoins, () => checkOrd(), checkPending, refreshDeploys, refreshMints, readCoinInscriptions, recoverShieldedTransfers, fetchPrice]) { try { await step(); } catch {} }
    else { try { saveCoins(); } catch {} }
    state.syncing = false; state.syncNote = '';
    if (state.approval) prepApproval();
    render();
    // indexer runs on its own, after the wallet sync has finished
    if (indexerUrl()) refreshIndexer().then(render, render);
    // restoring with a birthday: keep working back through history while the wallet is open
    const q = state.scanProgress;
    if (!state.syncErr && !state.histHold && q && q.floor > 0 && q.nextHeight >= q.floor && state.lockState === 'open') setTimeout(() => { if (!state.syncing) syncChain(12, { older: true }); }, 1500);
  }
}
const BIRTHDAYS = [['0', 'Never used (new wallet)'], ['7', 'In the last week'], ['30', 'In the last month'], ['90', 'In the last 3 months'], ['365', 'In the last year'], ['-1', "Not sure: I'll rescan by hand"]];
/** Block height for a date, with a day of margin (about 144 blocks a day). */
function birthdayHeight(ms, tip) { return Math.max(1, tip - Math.ceil((Date.now() - ms) / 600000) - 144); }
function historyLeft() { const p = state.scanProgress; return p && p.floor > 0 && p.nextHeight >= p.floor ? p.nextHeight - p.floor + 1 : 0; }

// ---------- coin selection ----------
function pickCoin(list, need) {
  return [...list].sort((a, b) => a.sats - b.sats).find((c) => c.sats >= need) || null;
}
function maxSendable(from) {
  const list = coinsFor(from);
  if (!list.length) return 0;
  const big = Math.max(...list.map((c) => c.sats));
  return Math.max(0, big - estimateSimpleSend({ outputs: 1, feeRate: feeRate() }));
}

// ---------- send / shield ----------
async function buildSend({ from, to, amount, rate }) {
  if (!canSign()) throw new Error('This wallet is watch-only and cannot send.');
  await ensureOrd(from);
  const label = from === 'shielded' ? 'Shielded' : 'Public';
  const list = coinsFor(from);
  if (!list.length) throw new Error(`Your ${label} balance is empty.`);
  const recipient = to === 'self' ? shieldAddr() : String(to).trim();
  const k = addrKind(recipient);
  if (k.kind === 'empty') throw new Error('Enter who to send to.');
  if (k.kind !== 'public' && k.kind !== 'shielded') throw new Error(k.text + '.');
  if (!Number.isSafeInteger(amount) || amount < 546) throw new Error(`Minimum is 0.00000546 ${unit()}.`);
  const feeOne = estimateSimpleSend({ outputs: 1, feeRate: rate });
  const feeTwo = estimateSimpleSend({ outputs: 2, feeRate: rate });
  const coin = pickCoin(list, amount + feeTwo + DUST_CHANGE) || pickCoin(list, amount + feeOne);
  if (!coin) throw new Error(`Not enough ${label} balance. You can send up to ${fmtBtc(maxSendable(from))} ${unit()}.`);
  const privKey = coin.privKey || sp.outputPrivKey(state.wallet.bSpend, coin.tweak);
  const wantChange = coin.sats - amount - feeTwo >= DUST_CHANGE;
  // Shielded change goes back to the wallet's own change address (label 0) so it stays private.
  const changeShielded = wantChange && from === 'shielded';
  const silent = [];
  if (k.kind === 'shielded') silent.push(recipient);
  if (changeShielded) silent.push(address(0));
  const derived = silent.length ? sp.createOutputs([{ txid: coin.txid, vout: coin.vout, privKey, taproot: true }], [{ txid: coin.txid, vout: coin.vout }], silent) : [];
  const take = (a) => derived.splice(derived.findIndex((d) => d.address === a), 1)[0].output;
  const outputs = [{ value: amount, script: k.kind === 'shielded' ? p2trScript(take(recipient)) : outputScriptFor(recipient) }];
  let fee = coin.sats - amount;
  if (wantChange) {
    fee = feeTwo;
    outputs.push({ value: coin.sats - amount - feeTwo, script: changeShielded ? p2trScript(take(address(0))) : p2trScript(coin.output) });
  }
  const tx = { inputs: [{ txid: coin.txid, vout: coin.vout, value: coin.sats, scriptPubKey: p2trScript(coin.output) }], outputs };
  const sig = await signTaprootKeySpend(tx, 0, privKey);
  const hex = encodeTx({ ...tx, witnesses: [[sig]] });
  return { hex, txid: txidOf(tx), amount, fee, coin, from, recipient, kind: k.kind, toSelf: to === 'self' };
}
async function afterBroadcast(spentKeys, txids) {
  state.coins = state.coins.filter((c) => !spentKeys.includes(c.key));
  state.fundingCoins = state.fundingCoins.filter((c) => !spentKeys.includes(c.key));
  saveCoins();
  render();
  for (const id of txids) await ingestTx(id);
  await syncFundingCoins().catch(() => {});
  render();
}

// ---------- inscriptions: mint / BRC2.0 predeploy + deploy ----------
// BRC2.0 rules follow Best in Slot's OPI indexer:
//  * 6-byte tickers ([a-z0-9-]) are BRC2.0 tokens.
//  * Step 1 "predeploy": {"p":"brc-20","op":"predeploy","hash":H} where
//    H = sha256(sha256(tick || salt || pkscript)), pkscript = output that receives the predeploy.
//  * Step 2 "deploy" (>= 3 blocks later): {"p":"brc-20","op":"deploy","tick","max","lim","salt"}
//    inscribed as a CHILD of the predeploy inscription (parent spent in the same reveal tx).
const CT_TEXT = 'text/plain;charset=utf-8';
const PREDEPLOY_DELAY = 3;
const tickLen = (t) => enc.encode(t).length;
const isV2 = (t) => tickLen(String(t || '')) === 6;
function checkTick(t, { deploy = false } = {}) {
  const n = tickLen(t);
  if (n === 6) { if (!/^[a-z0-9-]{6}$/.test(t)) throw new Error('BRC2.0 tickers use letters, numbers or dashes only.'); return; }
  if (deploy) throw new Error('BRC2.0 tickers are exactly 6 characters.');
  if (n === 4) return;
  if (n === 5) throw new Error('5-character tickers are self-mint only and are not supported here.');
  throw new Error('Ticker must be 4 characters (BRC-20) or 6 characters (BRC2.0).');
}
function checkAmount(v, label) {
  v = String(v || '').trim();
  if (!/^\d+(\.\d+)?$/.test(v) || /^0+(\.0+)?$/.test(v)) throw new Error(`${label} must be a number above 0.`);
  return v;
}
const randomHex = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); return toHex(b); };
// The salt is derived from the wallet's scan key + ticker + attempt, so a lost browser record
// can always be rebuilt from the recovery phrase (see recoverReservation).
function deriveSalt(tick, attempt = 0) {
  return toHex(sp.taggedHash('MASKED/predeploy-salt', n2b(state.wallet.bScan), enc.encode(tick), u32le(attempt)).slice(0, 16));
}
function predeployHash(tick, saltHex, pkscriptHex) {
  return toHex(sha256(sha256(concat(enc.encode(tick), fromHex(saltHex), fromHex(pkscriptHex)))));
}
function parentIdBytes(id) {
  const m = /^([0-9a-f]{64})i(\d+)$/.exec(id);
  if (!m) throw new Error('Bad parent inscription id.');
  let idx = u32le(+m[2]);
  let end = 4; while (end > 0 && idx[end - 1] === 0) end--;
  return concat(rev(fromHex(m[1])), idx.slice(0, end));
}
const jsonBody = (o) => enc.encode(JSON.stringify(o));

/** Builds commit + reveal. With `parent`, the reveal also spends the parent inscription and returns it to its owner. */
async function buildInscription({ from, body, recipient, rate, parent = null, parentId = null, meta = {}, rawRecipientScript = null, revealExtra = 0, postage = DEFAULT_REVEAL_VALUE }) {
  if (!canSign()) throw new Error('This wallet is watch-only and cannot inscribe.');
  await ensureOrd(from);
  // rawRecipientScript: inscribe onto an exact output script we control (e.g. a BRC-20 balance holder)
  const k = rawRecipientScript ? { kind: 'raw' } : addrKind(recipient);
  if (k.kind !== 'public' && k.kind !== 'shielded' && k.kind !== 'raw') throw new Error(k.kind === 'empty' ? 'Enter where to receive it.' : k.text + '.');
  const pBytes = parentId ? parentIdBytes(parentId) : null;
  const extra = parent ? Math.ceil((57.5 + 43) * rate) : 0;
  const est = (inputValue, bodyLength) => {
    const e = estimateOrdinalMint({ inputValue, feeRate: rate, bodyLength });
    e.revealFee += extra; e.totalFee += extra; e.change -= extra;
    e.change += e.revealValue - postage; e.revealValue = postage;
    e.revealValue += revealExtra; e.change -= revealExtra;
    return e;
  };
  const probeLen = body.length + inscriptionScript(ZERO32, CT_TEXT, body, pBytes).length;
  const label = from === 'shielded' ? 'Shielded' : from === 'trade' ? 'trade address' : 'Public';
  const list = coinsFor(from).filter((c) => !parent || c.key !== parent.key);
  if (!list.length) throw new Error(`Your ${label} balance is empty.`);
  const coin = [...list].sort((a, b) => a.sats - b.sats).find((c) => est(c.sats, probeLen).change >= 0);
  if (!coin) { const e = est(0, probeLen); throw new Error(`Not enough ${label} balance. This needs about ${fmtBtc(e.totalFee + e.revealValue)} ${unit()}.`); }
  const fundingPriv = coin.privKey || sp.outputPrivKey(state.wallet.bSpend, coin.tweak);
  const revealPub = xonly(mulG(b2n(normalizeSchnorrPriv(fundingPriv))));
  const script = inscriptionScript(revealPub, CT_TEXT, body, pBytes);
  const tap = taprootScriptOutput(fundingPriv, script);
  const estimate = est(coin.sats, body.length + script.length);
  const commitOutputs = [{ value: estimate.revealValue + estimate.revealFee, script: p2trScript(tap.outputX) }];
  if (estimate.change >= DUST_CHANGE) {
    let changeScript = p2trScript(coin.output);
    if (from === 'shielded') {
      const out = sp.createOutputs([{ txid: coin.txid, vout: coin.vout, privKey: fundingPriv, taproot: true }], [{ txid: coin.txid, vout: coin.vout }], [address(0)])[0];
      changeScript = p2trScript(out.output);
    }
    commitOutputs.push({ value: estimate.change, script: changeScript });
  } else {
    estimate.commitFee += estimate.change; estimate.totalFee += estimate.change; estimate.change = 0;
  }
  const commitTx = { inputs: [{ txid: coin.txid, vout: coin.vout, value: coin.sats, scriptPubKey: p2trScript(coin.output) }], outputs: commitOutputs };
  const commitSig = await signTaprootKeySpend(commitTx, 0, fundingPriv);
  const commitHex = encodeTx({ ...commitTx, witnesses: [[commitSig]] });
  const commitTxid = txidOf(commitTx);
  const commitIn = { txid: commitTxid, vout: 0, value: estimate.revealValue + estimate.revealFee, scriptPubKey: p2trScript(tap.outputX) };
  // Parent goes first so its sat lands in output 0; the new inscription (input 1) lands in output 1.
  const inputs = parent ? [{ txid: parent.txid, vout: parent.vout, value: parent.sats, scriptPubKey: p2trScript(parent.output) }, commitIn] : [commitIn];
  const silent = [];
  if (parent?.shielded) silent.push(address(0));
  if (k.kind === 'shielded') silent.push(recipient);
  let derived = [];
  if (silent.length) {
    const keys = [...(parent ? [{ txid: parent.txid, vout: parent.vout, privKey: parent.privKey, taproot: true }] : []), { txid: commitTxid, vout: 0, privKey: tap.outputPriv, taproot: true }];
    derived = sp.createOutputs(keys, inputs.map((i) => ({ txid: i.txid, vout: i.vout })), silent);
  }
  const take = (a) => derived.splice(derived.findIndex((x) => x.address === a), 1)[0].output;
  const parentBack = parent ? (parent.shielded ? p2trScript(take(address(0))) : p2trScript(parent.output)) : null;
  const recipientScript = k.kind === 'raw' ? rawRecipientScript : k.kind === 'shielded' ? p2trScript(take(recipient)) : outputScriptFor(recipient);
  const outputs = parent ? [{ value: parent.sats, script: parentBack }, { value: estimate.revealValue, script: recipientScript }] : [{ value: estimate.revealValue, script: recipientScript }];
  const revealTx = { inputs, outputs };
  const ci = parent ? 1 : 0;
  const witnesses = [];
  if (parent) witnesses.push([await signTaprootKeySpend(revealTx, 0, parent.privKey)]);
  witnesses[ci] = [await signTaprootScriptSpend(revealTx, ci, tap.internalPriv, tap.leafHash), script, tap.controlBlock];
  const revealHex = encodeTx({ ...revealTx, witnesses });
  const revealTxid = txidOf(revealTx);
  return {
    ...meta, coin, from, recipient, kind: k.kind, toSelf: recipient === shieldAddr(), body: new TextDecoder().decode(body), estimate,
    commitHex, commitTxid, revealHex, revealTxid, revealOut: ci, recipientSpk: toHex(recipientScript), inscriptionId: `${revealTxid}i0`, spent: [coin.key, ...(parent ? [parent.key] : [])],
  };
}
function heldCoin(txid, vout) {
  const f = state.fundingCoins.find((c) => c.txid === txid && c.vout === vout);
  if (f) return f;
  const c = state.coins.find((x) => x.txid === txid && x.vout === vout);
  return c ? { ...c, privKey: sp.outputPrivKey(state.wallet.bSpend, c.tweak), shielded: true } : null;
}
const mintedSoFar = (tick) => {
  const recorded = mints().filter((m) => m.tick === tick);
  const seen = new Set(recorded.map((m) => m.revealTxid));
  let total = recorded.reduce((a, m) => a + (Number(m.amt) || 0), 0);
  for (const c of [...(state.coins || []), ...(state.fundingCoins || [])]) { const i = inscOf(c); if (i?.brc20 && i.op === 'mint' && i.tick === tick && !seen.has(c.txid)) { seen.add(c.txid); total += Number(i.amt) || 0; } }
  return total;
};
// ---------- token supply / mint progress (from the token server) ----------
const tickInfoMemo = new Map(); // `${net}:${tick}` -> { at, data, busy }
function tickInfo(tick) {
  tick = String(tick || '').trim().toLowerCase();
  if (!indexerUrl() || ![4, 5, 6].includes(tickLen(tick))) return null;
  const k = `${state.net}:${tick}`; let e = tickInfoMemo.get(k);
  if (!e || (!e.busy && Date.now() - e.at > 60000)) {
    e = { at: Date.now(), data: e?.data, busy: true }; tickInfoMemo.set(k, e);
    const done = e;
    idxGet(`/v1/brc20/ticker_info?ticker=${encodeURIComponent(tick)}`)
      .then((d) => { done.data = d && d.max != null ? d : d === null ? { unknown: true } : done.data; })
      .catch((err) => { if (/unknown ticker/i.test(err.message)) done.data = { unknown: true }; })
      .finally(() => { done.busy = false; done.at = Date.now(); if (state.view === 'mint') render(); });
  }
  return e;
}
/** Why a mint of this ticker cannot work right now (or ''), from the token server's supply data. */
function mintBlock(tick) {
  tick = String(tick || '').trim().toLowerCase();
  const own = deploys().find((d) => d.tick === tick);
  if (own) return '';
  const d = tickInfo(tick)?.data;
  if (!d) return '';
  const T = tick.toUpperCase();
  if (d.unknown) return `${T} is not deployed, so a mint would not count.`;
  if (d.soldOut) return `${T} is sold out: all ${Number(d.max).toLocaleString()} are minted. A mint now would not count.`;
  if (d.selfMint) return `Only the deployer can mint ${T}.`;
  return '';
}
function supplyLine(tick) {
  tick = String(tick || '').trim().toLowerCase();
  const own = deploys().find((d) => d.tick === tick && d.status === 'deployed');
  const e = tickInfo(tick), d = e?.data;
  if (own?.selfMint) { const m = mintedSoFar(tick), max = Number(own.max) || 0; return supplyBar(m, max, max && m >= max); }
  if (!d) return e?.busy ? '<p class="supply muted small">Checking supply…</p>' : '';
  if (d.unknown) return ''; // the warning below says it
  return supplyBar(Number(d.minted), Number(d.max), d.soldOut, d.holders);
}
function supplyBar(minted, max, soldOut, holders) {
  const pct = max ? Math.min(100, (minted / max) * 100) : 0;
  return `<div class="supply ${soldOut ? 'out' : ''}"><div class="supply-bar"><i style="width:${pct.toFixed(2)}%"></i></div>
    <p class="small"><b>${soldOut ? 'Sold out' : `${pct < 0.01 && pct > 0 ? '<0.01' : pct.toFixed(pct < 10 ? 2 : 1)}% minted`}</b><span class="muted"> · ${minted.toLocaleString()} / ${max.toLocaleString()}${holders ? ` · ${Number(holders).toLocaleString()} holders` : ''}</span></p></div>`;
}
async function buildMint({ from, tick, amt, recipient, rate }) {
  tick = tick.trim().toLowerCase(); checkTick(tick);
  amt = checkAmount(amt, 'Amount');
  const blocked = mintBlock(tick); if (blocked) throw new Error(blocked);
  const info = tickInfo(tick)?.data;
  if (info?.max && !info.soldOut && Number(amt) > Number(info.max) - Number(info.minted)) throw new Error(`Only ${(Number(info.max) - Number(info.minted)).toLocaleString()} ${tick.toUpperCase()} left to mint.`);
  const dep = deploys().find((d) => d.tick === tick);
  if (dep && Number(amt) > Number(dep.lim)) throw new Error(`Max per mint for ${tick.toUpperCase()} is ${dep.lim}.`);
  if (dep?.selfMint) {
    // Self-mint: only mints inscribed as children of the deploy inscription count. We hold it, so we spend it as parent and keep it.
    const left = Number(dep.max) - mintedSoFar(tick);
    if (left <= 0) throw new Error(`The full ${tick.toUpperCase()} supply is already minted.`);
    if (Number(amt) > left) throw new Error(`Only ${left.toLocaleString()} ${tick.toUpperCase()} left to mint.`);
    const loc = dep.loc || { txid: dep.deployTxid, vout: 1 };
    const parent = heldCoin(loc.txid, loc.vout);
    if (!parent) throw new Error('Your deploy inscription is not in this wallet yet. Tap refresh on Coins.');
    return buildInscription({ from, body: brc20MintBody(tick, amt), recipient, rate, parent, parentId: dep.deployId, meta: { op: 'mint', tick, amt, selfMint: true } });
  }
  return buildInscription({ from, body: brc20MintBody(tick, amt), recipient, rate, meta: { op: 'mint', tick, amt } });
}
async function buildPredeploy({ from, tick, max, lim, rate, resTo = 'shielded', selfMint = false }) {
  tick = tick.trim().toLowerCase(); checkTick(tick, { deploy: true });
  max = checkAmount(max, 'Max supply'); lim = selfMint ? max : checkAmount(lim, 'Limit per mint');
  if (Number(lim) > Number(max)) throw new Error('Limit per mint cannot be more than max supply.');
  if (deploys().some((d) => d.tick === tick && d.status !== 'failed')) throw new Error(`You already started ${tick.toUpperCase()}.`);
  if (resTo === 'shielded') return { ...(await buildShieldedPredeploy({ from, tick, max, lim, rate })), selfMint };
  const f = fundingInfo();
  if (!f) throw new Error('This wallet has no Public address.');
  const salt = deriveSalt(tick, 0);
  const pkscript = toHex(p2trScript(f.outputX));
  const hash = predeployHash(tick, salt, pkscript);
  return buildInscription({ from, body: jsonBody({ p: 'brc-20', op: 'predeploy', hash }), recipient: f.address, rate, meta: { op: 'predeploy', tick, max, lim, salt, hash, pkscript, selfMint } });
}
// Shielded reservation: the predeploy hash commits to the pkscript the reservation lands on. A silent-payment
// output depends on the reveal's inputs, which contain that hash: a loop. We break it the BIP 352 way:
//  * the commit output's taproot internal key is the NUMS point, so it is NOT an eligible input;
//  * an "anchor" coin we own is the only eligible input, and its outpoint must be the smallest one.
// Then the shielded output depends only on the anchor and can be computed before the hash.
const NUMS_X = fromHex('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');
function numsScriptOutput(leafScript) {
  const lh = leafHash(leafScript);
  const P = lift(NUMS_X).add(mulG(tapTweak(NUMS_X, lh)));
  const parity = hasOddY(P) ? 1 : 0;
  return { leafHash: lh, outputX: toHex(xonly(P)), controlBlock: concat(u8(TAP_LEAF_VERSION | parity), NUMS_X) };
}
const outpointBytes = (txid, vout) => concat(rev(fromHex(txid)), u32le(vout));
function lessThan(a, b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; }
async function buildShieldedPredeploy({ from, tick, max, lim, rate }) {
  await ensureOrd();
  if (!canSign()) throw new Error('This wallet is watch-only and cannot inscribe.');
  const payList = coinsFor(from);
  if (!payList.length) throw new Error(`Your ${from === 'shielded' ? 'Shielded' : 'Public'} balance is empty.`);
  const ownAddr = shieldAddr(), changeAddr = address(0);
  const REVEAL_VAL = DEFAULT_REVEAL_VALUE;
  for (let attempt = 0; attempt < 64; attempt++) {
    const salt = deriveSalt(tick, attempt);
    const body = jsonBody({ p: 'brc-20', op: 'predeploy', hash: '0'.repeat(64) });
    // pick the coin that pays for the commit, and a different coin as the anchor (prefer Shielded)
    const commitFee = Math.ceil((10.5 + 57.5 + 43 + 43) * rate);
    const commitCoin = [...payList].sort((a, b) => a.sats - b.sats).find((c) => c.sats >= REVEAL_VAL + commitFee + DUST_CHANGE);
    if (!commitCoin) throw new Error(`Not enough ${from === 'shielded' ? 'Shielded' : 'Public'} balance for the reservation.`);
    const anchors = [...shieldedCoins(), ...publicCoins()].filter((c) => c.key !== commitCoin.key);
    const probe = inscriptionScript(ZERO32, CT_TEXT, body);
    const revealFee = Math.ceil((10.5 + 57.5 + 43 + (64 + compactSizeLength(body.length + probe.length) + body.length + probe.length + 65) / 4 + 1 + 57.5 + 43) * rate);
    const anchor = anchors.sort((a, b) => b.sats - a.sats).find((c) => c.sats - revealFee >= DUST_CHANGE);
    if (!anchor) throw new Error('A Shielded reservation needs two coins: one to pay and one more to anchor it. Shield part of your balance (not all), then try again.');
    const anchorPriv = anchor.privKey || sp.outputPrivKey(state.wallet.bSpend, anchor.tweak);
    // shielded outputs depend only on the anchor (the commit input is NUMS → ineligible)
    const outs = sp.createOutputs([{ txid: anchor.txid, vout: anchor.vout, privKey: anchorPriv, taproot: true }], [{ txid: anchor.txid, vout: anchor.vout }], [ownAddr, changeAddr]);
    const resX = outs[0].output, chgX = outs[1].output;
    const pkscript = toHex(p2trScript(resX));
    const hash = predeployHash(tick, salt, pkscript);
    const realBody = jsonBody({ p: 'brc-20', op: 'predeploy', hash });
    const commitPriv = commitCoin.privKey || sp.outputPrivKey(state.wallet.bSpend, commitCoin.tweak);
    const signPriv = normalizeSchnorrPriv(commitPriv);
    const script = inscriptionScript(xonly(mulG(b2n(signPriv))), CT_TEXT, realBody);
    const tap = numsScriptOutput(script);
    const commitOutputs = [{ value: REVEAL_VAL, script: p2trScript(tap.outputX) }];
    const change = commitCoin.sats - REVEAL_VAL - commitFee;
    let changeScript = p2trScript(commitCoin.output);
    if (from === 'shielded') changeScript = p2trScript(sp.createOutputs([{ txid: commitCoin.txid, vout: commitCoin.vout, privKey: commitPriv, taproot: true }], [{ txid: commitCoin.txid, vout: commitCoin.vout }], [changeAddr])[0].output);
    commitOutputs.push({ value: change, script: changeScript });
    const commitTx = { inputs: [{ txid: commitCoin.txid, vout: commitCoin.vout, value: commitCoin.sats, scriptPubKey: p2trScript(commitCoin.output) }], outputs: commitOutputs };
    const commitTxid = txidOf(commitTx);
    // the anchor must be the smallest outpoint of the reveal, otherwise the address we hashed is wrong
    if (!lessThan(outpointBytes(anchor.txid, anchor.vout), outpointBytes(commitTxid, 0))) continue;
    const commitHex = encodeTx({ ...commitTx, witnesses: [[await signTaprootKeySpend(commitTx, 0, commitPriv)]] });
    // reveal: input 0 = commit (envelope → inscription on sat 0 → output 0), input 1 = anchor (pays the fee)
    const revealTx = {
      inputs: [{ txid: commitTxid, vout: 0, value: REVEAL_VAL, scriptPubKey: p2trScript(tap.outputX) }, { txid: anchor.txid, vout: anchor.vout, value: anchor.sats, scriptPubKey: p2trScript(anchor.output) }],
      outputs: [{ value: REVEAL_VAL, script: p2trScript(resX) }, { value: anchor.sats - revealFee, script: p2trScript(chgX) }],
    };
    const w0 = [await signTaprootScriptSpend(revealTx, 0, signPriv, tap.leafHash), script, tap.controlBlock];
    const w1 = [await signTaprootKeySpend(revealTx, 1, anchorPriv)];
    const revealHex = encodeTx({ ...revealTx, witnesses: [w0, w1] });
    const revealTxid = txidOf(revealTx);
    const estimate = { commitFee, revealFee, totalFee: commitFee + revealFee, revealValue: REVEAL_VAL, change };
    return {
      op: 'predeploy', tick, max, lim, salt, hash, pkscript, shieldedReservation: true,
      coin: commitCoin, from, recipient: ownAddr, kind: 'shielded', toSelf: true, body: new TextDecoder().decode(realBody), estimate,
      commitHex, commitTxid, revealHex, revealTxid, revealOut: 0, inscriptionId: `${revealTxid}i0`, spent: [commitCoin.key, anchor.key],
    };
  }
  throw new Error('Could not line up the reservation. Try again.');
}
async function buildDeploy(d, { from, recipient, rate }) {
  let parent = state.fundingCoins.find((c) => c.txid === d.predeployTxid && c.vout === 0) || state.coins.find((c) => c.txid === d.predeployTxid && c.vout === 0);
  if (!parent) throw new Error('Reservation coin not found yet. Tap refresh on Coins.');
  if (!parent.privKey) parent = { ...parent, privKey: sp.outputPrivKey(state.wallet.bSpend, parent.tweak), shielded: true };
  return buildInscription({
    from, recipient, rate, parent, parentId: d.predeployId,
    body: jsonBody({ p: 'brc-20', op: 'deploy', tick: d.tick, max: d.max, lim: d.lim, ...(d.selfMint ? { self_mint: 'true' } : {}), salt: d.salt }),
    meta: { op: 'deploy', tick: d.tick, max: d.max, lim: d.lim, deployOf: d.tick },
  });
}

// deploy records (per wallet + network)
const deployKey = () => `wren.deploys.${walletId()}`;
function orphanReservations() {
  const list = deploys();
  return [...state.coins, ...state.fundingCoins].filter((c) => {
    const i = inscOf(c);
    if (!i?.brc20 || i.op !== 'predeploy') return false;
    return !list.some((d) => d.predeployTxid === c.txid || d.deployTxid === c.txid || d.loc?.txid === c.txid);
  });
}
async function recoverReservation(coin, { tick, max, selfMint, lim, salt: manualSalt }) {
  tick = String(tick || '').trim().toLowerCase(); checkTick(tick, { deploy: true });
  max = checkAmount(max, 'Max supply'); lim = selfMint ? max : checkAmount(lim, 'Limit per mint');
  const r = await fetch(`${esploraBase()}tx/${coin.txid}`);
  if (!r.ok) throw new Error('Could not load the reservation transaction.');
  const tx = await r.json();
  let hash = null;
  for (const v of tx.vin) for (const e of envelopesIn(v.witness || [])) { const d = describeEnvelope(e); if (d.op === 'predeploy') hash = d.hash; }
  if (!hash) throw new Error('No reservation found in that transaction.');
  const pkscript = tx.vout[coin.vout].scriptpubkey;
  const candidates = manualSalt ? [manualSalt.trim().toLowerCase()] : Array.from({ length: 64 }, (_, a) => deriveSalt(tick, a));
  const salt = candidates.find((x) => /^[0-9a-f]+$/.test(x) && predeployHash(tick, x, pkscript) === hash);
  if (!salt) throw new Error(manualSalt ? 'That salt does not match this reservation.' : `This reservation is not for ${tick.toUpperCase()}, or it was made by an older version with a random salt that is no longer stored. Check the ticker, or reserve again.`);
  saveDeploys([...deploys().filter((d) => d.tick !== tick), { tick, max, lim, selfMint: !!selfMint, salt, hash, pkscript, predeployTxid: coin.txid, predeployId: `${coin.txid}i0`, height: tx.status?.confirmed ? tx.status.block_height : null, status: 'reserved', at: Date.now(), recovered: true }]);
  setInsc(`${coin.txid}:${coin.vout}`, { brc20: true, op: 'predeploy', tick, hash, id: `${coin.txid}i0` });
  return tick;
}
function deploys() { try { return JSON.parse(localStorage.getItem(deployKey()) || '[]'); } catch { return []; } }
function saveDeploys(list) { try { localStorage.setItem(deployKey(), JSON.stringify(list)); } catch {} }
function updateDeploy(tick, patch) { saveDeploys(deploys().map((d) => (d.tick === tick ? { ...d, ...patch } : d))); }
function deployStage(d) {
  if (d.status === 'deployed') return { key: 'deployed', text: 'Deployed' };
  if (!d.height) return { key: 'wait', text: 'Waiting for the reservation to confirm…' };
  const left = d.height + PREDEPLOY_DELAY - (state.tip || 0);
  if (left > 0) return { key: 'wait', text: `Reserved in block ${d.height.toLocaleString()} · ${left} more block${left === 1 ? '' : 's'} to wait` };
  return { key: 'ready', text: 'Ready to deploy' };
}
const mintKey = () => `wren.mints.${walletId()}`;
function mints() { try { return JSON.parse(localStorage.getItem(mintKey()) || '[]'); } catch { return []; } }
function saveMints(list) { try { localStorage.setItem(mintKey(), JSON.stringify(list.slice(0, 200))); } catch {} }
async function refreshMints() {
  const list = mints();
  for (const m of list.filter((x) => !x.height).slice(0, 20)) {
    try { const r = await fetch(`${esploraBase()}tx/${m.revealTxid}/status`); const st = r.ok ? await r.json() : null; if (st?.confirmed) m.height = st.block_height; } catch {}
  }
  saveMints(list);
}
/** Tickers this wallet knows: deployed by you, minted by you, or found in your coins. */
function knownTokens() {
  const t = new Map();
  const add = (tick, patch = {}) => { if (!tick) return; const x = t.get(tick) || { tick, minted: 0, mints: 0, deployed: false, lim: null }; Object.assign(x, patch); t.set(tick, x); return x; };
  for (const d of deploys()) if (d.status === 'deployed') add(d.tick, { deployed: true, lim: d.lim });
  for (const m of mints()) { const x = add(m.tick); x.minted += Number(m.amt) || 0; x.mints++; }
  for (const c of [...state.coins, ...state.fundingCoins]) { const i = inscOf(c); if (i?.brc20 && i.op === 'mint' && !mints().some((m) => m.revealTxid === c.txid)) { const x = add(i.tick); x.minted += Number(i.amt) || 0; x.mints++; } }
  for (const c of [...state.coins, ...state.fundingCoins]) { const i = inscOf(c); if (i?.brc20 && i.op === 'transfer' && i.received && i.tick) add(i.tick); }
  for (const it of idxWallet()?.list || []) if (Number(it.overall) > 0) add(it.ticker);
  return [...t.values()];
}
const ago = (ms) => { const s = Math.max(1, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const inscUrl = (id) => `${DEFAULT_INDEXER[state.net]}/inscription/${id}`;
async function refreshDeploys() {
  const list = deploys();
  for (const d of list) {
    try {
      if (!d.height) {
        const r = await fetch(`${esploraBase()}tx/${d.predeployTxid}/status`);
        const s = r.ok ? await r.json() : null;
        if (s?.confirmed) d.height = s.block_height;
      }
    } catch {}
  }
  saveDeploys(list);
}

// ---------- reading inscriptions held by small coins ----------
const inscKey = () => `wren.insc.${state.net}`;
function inscCache() { try { return state._insc || (state._insc = JSON.parse(localStorage.getItem(inscKey()) || '{}')); } catch { return (state._insc = {}); } }
function setInsc(outpoint, info) { const c = inscCache(); c[outpoint] = info; try { localStorage.setItem(inscKey(), JSON.stringify(c)); } catch {} }
const inscOf = (c) => inscCache()[`${c.txid}:${c.vout}`] || null;
function parseScriptPushes(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    const op = s[i++];
    if (op === 0) out.push(new Uint8Array());
    else if (op <= 75) { out.push(s.slice(i, i + op)); i += op; }
    else if (op === 76) { const n = s[i]; out.push(s.slice(i + 1, i + 1 + n)); i += 1 + n; }
    else if (op === 77) { const n = s[i] | (s[i + 1] << 8); out.push(s.slice(i + 2, i + 2 + n)); i += 2 + n; }
    else if (op === 78) { const n = new DataView(s.buffer, s.byteOffset + i, 4).getUint32(0, true); out.push(s.slice(i + 4, i + 4 + n)); i += 4 + n; }
    else if (op >= 0x51 && op <= 0x60) out.push(Uint8Array.from([op - 0x50]));
    else out.push({ op });
  }
  return out;
}
function envelopesIn(witnessHex) {
  let w = witnessHex.map((h) => fromHex(h));
  if (w.length >= 2 && w[w.length - 1][0] === TAPROOT_ANNEX_PREFIX) w = w.slice(0, -1);
  if (w.length < 2) return [];
  const cb = w[w.length - 1];
  if (cb.length < 33 || (cb.length - 33) % 32 !== 0 || (cb[0] & 0xfe) !== TAP_LEAF_VERSION) return [];
  const items = parseScriptPushes(w[w.length - 2]);
  const env = [];
  for (let i = 0; i + 2 < items.length; i++) {
    const a = items[i], b = items[i + 1], c = items[i + 2];
    if (a instanceof Uint8Array && a.length === 0 && b?.op === OP.IF && c instanceof Uint8Array && new TextDecoder().decode(c) === 'ord') {
      let j = i + 3; const tags = {}; const body = [];
      for (; j < items.length && items[j]?.op !== OP.ENDIF; j += 2) {
        const tag = items[j];
        if (!(tag instanceof Uint8Array)) break;
        if (tag.length === 0) { j++; for (; j < items.length && items[j]?.op !== OP.ENDIF; j++) if (items[j] instanceof Uint8Array) body.push(items[j]); break; }
        tags[tag[0]] = items[j + 1];
      }
      env.push({ contentType: tags[1] ? new TextDecoder().decode(tags[1]) : '', body: body.length ? concat(...body) : new Uint8Array() });
      i = j;
    }
  }
  return env;
}
function describeEnvelope(e) {
  if (/^(text\/plain|application\/json)/.test(e.contentType)) {
    try {
      const j = JSON.parse(new TextDecoder().decode(e.body));
      if (j && j.p === 'brc-20' && typeof j.op === 'string') return { brc20: true, op: j.op, tick: String(j.tick || '').toLowerCase(), amt: j.amt, max: j.max, hash: j.hash };
    } catch {}
  }
  return { brc20: false, contentType: e.contentType };
}
/** For each small coin we hold, look at the tx that created it and see whether an inscription was born on it. */
async function readCoinInscriptions() {
  const cache = inscCache();
  const todo = [...state.fundingCoins, ...state.coins].filter((c) => c.sats != null && c.sats <= INSCRIPTION_MAX && !(`${c.txid}:${c.vout}` in cache) && !c.example);
  const byTx = new Map();
  for (const c of todo) { if (!byTx.has(c.txid)) byTx.set(c.txid, []); byTx.get(c.txid).push(c); }
  for (const [txid, coins] of byTx) {
    try {
      const r = await fetch(`${esploraBase()}tx/${txid}`);
      if (!r.ok) continue;
      const tx = await r.json();
      const found = {};
      let offset = 0, idx = 0;
      tx.vin.forEach((v) => {
        for (const e of envelopesIn(v.witness || [])) {
          let acc = 0;
          const n = tx.vout.findIndex((o) => (acc += o.value) > offset);
          if (n >= 0 && found[n] == null) found[n] = { ...describeEnvelope(e), id: `${txid}i${idx}`, at: tx.status?.block_time ? tx.status.block_time * 1000 : undefined };
          idx++;
        }
        offset += v.prevout?.value || 0;
      });
      // One hop back: a coin can hold an inscription that was born in an earlier tx and moved here
      // (e.g. a BRC-20 transfer delivered to us). Follow the first sat of our output to its input.
      for (const c of coins) {
        if (found[c.vout]) continue;
        const outStart = tx.vout.slice(0, c.vout).reduce((a, o) => a + o.value, 0);
        let inStart = 0, src = null;
        for (const v of tx.vin) { const val = v.prevout?.value || 0; if (outStart >= inStart && outStart < inStart + val) { src = outStart === inStart ? v : null; break; } inStart += val; }
        if (!src) continue;
        try {
          const pr = await fetch(`${esploraBase()}tx/${src.txid}`);
          if (!pr.ok) continue;
          const ptx = await pr.json();
          const pStart = ptx.vout.slice(0, src.vout).reduce((a, o) => a + o.value, 0);
          let off = 0, k = 0;
          for (const v of ptx.vin) {
            for (const e of envelopesIn(v.witness || [])) { if (off === pStart) found[c.vout] = { ...describeEnvelope(e), id: `${src.txid}i${k}`, received: true, from: src.prevout?.scriptpubkey_address || '', at: tx.status?.block_time ? tx.status.block_time * 1000 : undefined }; k++; }
            off += v.prevout?.value || 0;
          }
        } catch {}
      }
      if (!tx.status?.confirmed && !Object.keys(found).length) continue; // try again later
      for (const c of coins) setInsc(`${c.txid}:${c.vout}`, found[c.vout] || { brc20: false, unknown: true });
    } catch {}
  }
}

// ---------- manual scan (advanced) ----------
function runScan() {
  const text = String(state.f.scanText || '').trim();
  if (!text) return setStatus('scan', 'Paste transaction JSON first.', 'err');
  if (!state.wallet) return setStatus('scan', 'Set up a wallet first.', 'err');
  let json;
  try { json = JSON.parse(text); } catch { return setStatus('scan', 'That is not valid JSON.', 'err'); }
  const txs = extractTxs(json);
  let hits = 0, errs = 0;
  for (const t of txs) { try { hits += scanTx(t).n || 0; } catch { errs++; } }
  saveCoins();
  setStatus('scan', `Checked ${txs.length} transaction${txs.length === 1 ? '' : 's'} · ${hits} shielded payment${hits === 1 ? '' : 's'} found${errs ? ` · ${errs} unreadable` : ''}.`, hits ? 'ok' : errs ? 'err' : '');
}

// ---------- old output calculator (advanced) ----------
function computeSend() {
  const rows = [...document.querySelectorAll('#sendInputs .inrow')];
  const allOutpoints = [], eligible = [];
  rows.forEach((r, i) => {
    const op = r.querySelector('[data-f=op]').value.trim();
    const m = op.match(/^([0-9a-fA-F]{64}):(\d+)$/);
    if (!m) throw new Error(`Input ${i + 1}: outpoint must look like <txid>:<vout>`);
    const type = r.querySelector('[data-f=type]').value;
    allOutpoints.push({ txid: m[1].toLowerCase(), vout: +m[2] });
    if (type === 'other') return;
    const keyField = r.querySelector('[data-f=key]').value;
    if (!keyField.trim()) throw new Error(`Input ${i + 1}: enter its private key, or set it to "Not eligible"`);
    eligible.push({ txid: m[1].toLowerCase(), vout: +m[2], privKey: parsePriv(keyField), taproot: type === 'p2tr' });
  });
  if (!rows.length) throw new Error('Add at least one input');
  const recips = String(state.f.calcRecips || '').split(/[\s,]+/).filter(Boolean);
  if (!recips.length) throw new Error('Add at least one shielded address');
  for (const a of recips) if (addrKind(a).kind !== 'shielded') throw new Error(`${short(a, 8)}: ${addrKind(a).text || 'not a shielded address'}`);
  return sp.createOutputs(eligible, allOutpoints, recips);
}
function inputRow(v = {}) {
  return `<div class="inrow">
    <label class="field"><span>Outpoint (txid:vout)</span><input data-f="op" class="mono" value="${esc(v.op || '')}" spellcheck="false" placeholder="txid:0"></label>
    <label class="field"><span>Type</span><select data-f="type">${[['p2tr', 'Taproot'], ['p2wpkh', 'Native SegWit'], ['p2sh', 'Nested SegWit'], ['p2pkh', 'Legacy'], ['other', 'Not eligible']].map(([k, n]) => `<option value="${k}" ${v.type === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label class="field"><span>Private key (hex or WIF)</span><input data-f="key" type="password" class="mono" value="${esc(v.key || '')}" autocomplete="off" spellcheck="false"></label>
    <button class="btn ghost sm" data-rmin>Remove input</button>
  </div>`;
}

// =====================================================================
// Rendering
// =====================================================================
const I = {
  send: '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>',
  recv: '<svg viewBox="0 0 24 24"><path d="M17 7 7 17M15 17H7V9"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.5 3 8.3 7 9.5 4-1.2 7-5 7-9.5V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></svg>',
  shieldPlain: '<svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.5 3 8.3 7 9.5 4-1.2 7-5 7-9.5V6l-7-3Z"/></svg>',
  mint: '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5Z"/></svg>',
  wallet: '<svg viewBox="0 0 24 24"><rect x="3.5" y="6" width="17" height="13" rx="3"/><path d="M16 12.5h2M3.5 9.5h17"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 18 9 12l6-6"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9.5" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9.5" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
};
const btcLogo = '<span class="coin btc">₿</span>';
const shieldLogo = `<span class="coin sh">${I.shieldPlain}</span>`;
const copyBtn = (val, label = 'Copy') => `<button class="btn ghost sm" data-copy="${esc(val)}">${I.copy}<span>${label}</span></button>`;
const back = (to = 'home') => `<button class="icon-btn" data-go="${to}" aria-label="Back">${I.back}</button>`;
const statusLine = (key) => { const s = state.status[key]; return s ? `<p class="msg ${s[1]}" role="status">${esc(s[0])}</p>` : ''; };
function setStatus(key, text, cls = '') { state.status[key] = text ? [text, cls] : null; render(); }
function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(/^t?sp1|^(bc|tb)1/i.test(text) ? text.toUpperCase() : text, /^t?sp1|^(bc|tb)1/i.test(text) ? 'Alphanumeric' : 'Byte');
  q.make();
  const n = q.getModuleCount(), m = 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + m} ${y + m}h1v1h-1z`;
  return `<svg viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" class="qr" role="img" aria-label="QR code" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
}
function addrChunks(a) { return a.match(/.{1,4}/g).map((c, i) => `<span class="${i % 2 ? 'alt' : ''}">${c}</span>`).join(''); }
const seg = (name, value, opts) => `<div class="seg" role="radiogroup">${opts.map(([v, label]) => `<button role="radio" aria-checked="${value === v}" data-set="${name}" data-val="${v}">${label}</button>`).join('')}</div>`;
function feeChips() {
  const f = state.fees, k0 = state.f.fee;
  const card = (k, name, time, cls = '') => `<button class="fee ${cls} ${k0 === k ? 'on' : ''}" data-set="fee" data-val="${k}"><b>${name}</b><span class="r"><em>${fmtRate(f[k])}</em> sat/vB</span><span class="t">${time}</span></button>`;
  const v = state.f.feeCustom || '', bad = k0 === 'custom' && v !== '' && !customFee();
  const high = k0 === 'custom' && customFee() > Math.max(50, f.fast * 5);
  return `<div class="fees">
      ${card('slow', f.slow < 1 ? 'Sub 1' : 'Slow', 'slower')}
      ${card('normal', 'Avg', '~30 min', 'avg')}
      ${card('fast', 'Fast', '~10 min', 'fast')}
      <button class="fee custom ${k0 === 'custom' ? 'on' : ''}" data-set="fee" data-val="custom"><b>Custom</b>${k0 === 'custom' && customFee() ? `<span class="r"><em>${fmtRate(customFee())}</em> sat/vB</span>` : ''}</button>
    </div>
    ${k0 === 'custom' ? `<div class="amount fee-in"><input id="feeCustom" data-bind="feeCustom" type="number" inputmode="decimal" min="${FEE_MIN}" max="${FEE_MAX}" step="0.01" placeholder="e.g. ${fmtRate(f.slow)}" value="${esc(v)}" autocomplete="off"><span class="unit">sat/vB</span></div>
      <p class="fee-note ${bad ? 'bad' : high ? 'warn' : ''}" id="feeNote">${bad ? `Enter ${FEE_MIN} to ${FEE_MAX} sat/vB. Using Avg (${fmtRate(f.normal)}) until then.` : high ? 'That is much higher than needed right now.' : `Lowest ${FEE_MIN} sat/vB. Below 1 is cheapest but can wait longer if blocks fill up.`}</p>` : ''}
    <div class="rbf-row"><span>RBF <button class="q" data-rbfinfo aria-label="What is RBF?">?</button></span><label class="sw-tgl"><input type="checkbox" data-rbf ${RBF ? 'checked' : ''}><span></span></label></div>
    ${state.f.rbfInfo ? '<p class="fee-note">Replace-by-fee: if the transaction gets stuck, it can be replaced with a higher fee. Some sellers ask for RBF off; most people leave it on.</p>' : ''}`;
}
function netBanner() {
  return isTest() ? `<div class="testnet-note"><span class="dot-warn"></span>${net().name} · test coins with no real value</div>` : '';
}

// ---------- Public | Shielded: the side the wallet is showing ----------
// Home, the header address and the defaults of Send, Receive and Mint follow the side picked on Home.
function getSide() { if (!state.side) { try { state.side = localStorage.getItem('wren.side') === 'shielded' ? 'shielded' : 'public'; } catch { state.side = 'public'; } } return state.side; }
function setSide(k) {
  state.side = k === 'shielded' ? 'shielded' : 'public';
  try { localStorage.setItem('wren.side', state.side); } catch {}
  for (const f of ['recvKind', 'sendFrom', 'mintFrom', 'trFrom', 'tsFrom', 'depFrom']) state.f[f] = state.side;
}
const sideAddr = () => (getSide() === 'shielded' ? shieldAddr() : pubAddr());
function viewHome() {
  const w = state.wallet;
  if (!w) return `<section class="card center"><p>No wallet yet.</p><button class="btn primary" data-go="settings">Set up wallet</button></section>`;
  const pub = sum(state.fundingCoins), sh = sum(state.coins);
  const total = pub + sh;
  const side = getSide(), shd = side === 'shielded', mine = shd ? sh : pub;
  const hint = !total
    ? `<div class="hint"><b>Get started</b><span>Tap <b>Receive</b> and send ${unit()} to your Public address.</span></div>`
    : pub > INSCRIPTION_MAX && !sh
      ? `<button class="hint hint-cta" data-go="shield"><span class="hint-ic">${I.shield}</span><span><b>Make it private</b><span>Move your Public balance into Shielded.</span></span><span class="chev">›</span></button>`
      : '';
  return `
    ${w.source === 'example' ? '<div class="testnet-note warn">Demo wallet — keys are public. Create your own in Settings.</div>' : netBanner()}
    <section class="hero ${shd ? 'sh' : ''}">
      <p class="hero-label">${shd ? `${I.shieldPlain} Shielded balance` : 'Public balance'}</p>
      <p class="hero-bal">${fmtBtc(mine)} <small>${unit()}</small></p>
      <p class="hero-usd">${usdOf(mine) ? `≈ ${usdOf(mine)} · ` : ''}Total ${fmtBtc(total)} ${unit()}</p>
      <button class="sync ${state.syncing ? 'spin' : ''} ${state.syncErr ? 'bad' : ''}" id="btnSync" title="${esc(state.syncErr || '')}">${I.refresh}<span>${syncText()}</span></button>
      <div class="actions">
        <button class="act" data-go="receive" data-recv="${side}"><span class="act-ic ${shd ? 'sh' : ''}">${I.recv}</span><span>Receive</span></button>
        <button class="act" data-go="send"><span class="act-ic ${shd ? 'sh' : ''}">${I.send}</span><span>Send</span></button>
        ${shd ? `<a class="act" href="https://maskedwallet.com/swap?from=shielded" target="_blank" rel="noopener"><span class="act-ic sh">${I.list}</span><span>Trade</span></a>`
          : `<button class="act" data-go="shield"><span class="act-ic sh">${I.shield}</span><span>Shield</span></button>`}
        <button class="act" data-go="mint"><span class="act-ic">${I.mint}</span><span>Mint</span></button>
      </div>
    </section>
    ${hint}
    ${(() => { const n = [...state.fundingCoins, ...state.coins].filter((c) => !c.example && isProtected(c)).length; return n ? `<button class="protect-row" data-go="activity" data-filter="brc2">${I.lock}<span><b>${n} inscription coin${n === 1 ? '' : 's'} protected</b> · never spent by Send, Shield or Mint</span><span class="chev">›</span></button>` : ''; })()}
    <section class="balances" role="radiogroup" aria-label="Show">
      <button class="bal-row ${shd ? '' : 'on'}" data-side="public" role="radio" aria-checked="${!shd}">
        ${btcLogo}
        <span class="bal-txt"><b>Public</b><span>Visible on the blockchain</span></span>
        <span class="bal-amt"><b>${fmtBtc(pub)}</b><span>${usdOf(pub) || unit()}</span></span>
      </button>
      <button class="bal-row shielded ${shd ? 'on' : ''}" data-side="shielded" role="radio" aria-checked="${shd}">
        ${shieldLogo}
        <span class="bal-txt"><b>Shielded</b><span>Private · only you see it</span></span>
        <span class="bal-amt"><b>${fmtBtc(sh)}</b><span>${usdOf(sh) || unit()}</span></span>
      </button>
    </section>
    ${homeTokens(side)}`;
}

function viewReceive() {
  const kind = state.f.recvKind;
  const a = kind === 'shielded' ? shieldAddr() : pubAddr();
  if (!a) return `${head('Receive')}<section class="card"><p class="muted">This wallet has no ${kind} address.</p></section>`;
  const info = kind === 'shielded'
    ? 'For wallets that support <b>silent payments</b>. Each payment lands somewhere new, so nobody can link them to you.'
    : 'For exchanges, faucets and any Bitcoin wallet. Payments here are <b>public</b>.';
  return `
    ${head('Receive')}
    ${seg('recvKind', kind, [['public', 'Public'], ['shielded', `${I.shieldPlain} Shielded`]])}
    <section class="card receive ${kind}">
      <div class="recv-badge">${kind === 'shielded' ? `${shieldLogo}<b>Shielded address</b>` : `${btcLogo}<b>Public address</b>`}</div>
      <div class="qr-wrap">${qrSvg(a)}</div>
      <p class="addr mono">${addrChunks(a)}</p>
      <button class="btn primary wide" data-copy="${esc(a)}">${I.copy}<span>Copy address</span></button>
      <p class="info">${info}</p>
      ${isTest() ? `<p class="info warn">${net().name} only. Never send real bitcoin here.</p>` : ''}
    </section>`;
}
function head(title, to = 'home') { return `<div class="view-head">${back(to)}<h1>${title}</h1><span class="head-sp"></span></div>`; }

function viewSend(mode) {
  const shield = mode === 'shield';
  const st = state.send;
  if (st.stage === 'review' && st.built) return viewSendReview(st.built);
  if (st.stage === 'done' && st.built) return viewDone(st.built.toSelf ? 'Shielded!' : 'Sent!', `${fmtBtc(st.built.amount)} ${unit()}${st.built.toSelf ? ' moved to your Shielded balance.' : ' is on its way.'}`, st.built.txid, st.built.toSelf ? 'It shows up as pending until the next block.' : '');
  const from = shield ? 'public' : state.f.sendFrom;
  const bal = sum(coinsFor(from));
  const k = addrKind(state.f.sendTo);
  return `
    ${head(shield ? 'Shield' : 'Send')}
    ${shield ? `<section class="explain">${shieldLogo}<p><b>Shielding</b> moves coins from your Public balance into your Shielded balance. After that, your coins can't be traced to your public address.</p></section>` : ''}
    <section class="card form">
      ${shield ? '' : `<div class="field"><span class="lbl">From</span>${seg('sendFrom', from, [['public', `Public · ${spendLabel('public')}`], ['shielded', `${I.shieldPlain} Shielded · ${spendLabel('shielded')}`]])}</div>`}
      ${shield ? `<div class="flow"><div class="flow-end">${btcLogo}<span><b>Public</b><small>${fmtBtc(bal)} ${unit()}</small></span></div><span class="flow-arrow">→</span><div class="flow-end">${shieldLogo}<span><b>Shielded</b><small>${fmtBtc(sum(state.coins))} ${unit()}</small></span></div></div>`
        : `<label class="field"><span class="lbl">To</span><input id="sendTo" data-bind="sendTo" class="mono" spellcheck="false" autocomplete="off" value="${esc(state.f.sendTo)}" placeholder="Paste a Bitcoin or shielded address">
          <span class="addr-kind k-${k.kind}" id="sendKind">${k.kind === 'empty' ? `<button class="link" data-fillself>Send to my own Shielded address</button>` : esc(k.text)}</span></label>`}
      <label class="field"><span class="lbl">Amount <span class="lbl-r">Available ${fmtBtc(bal)} ${unit()}</span></span>
        <div class="amount"><input id="sendAmount" data-bind="sendAmount" inputmode="decimal" autocomplete="off" value="${esc(state.f.sendAmount)}" placeholder="0.00"><span class="unit">${unit()}</span><button class="max" data-max="${from}">MAX</button></div>
      </label>
      <div class="field"><span class="lbl">Network fee</span>${feeChips()}</div>
      ${statusLine('send')}
      <button class="btn primary wide" id="btnReviewSend">${shield ? 'Review shield' : 'Review'}</button>
    </section>`;
}
function rowKV(k, v) { return `<div class="kvrow"><span>${k}</span><span>${v}</span></div>`; }
function viewSendReview(b) {
  const toTxt = b.toSelf ? `${shieldLogo}<b>My Shielded balance</b>` : `<span class="mono">${esc(short(b.recipient, 10))}</span>`;
  return `
    <div class="view-head"><button class="icon-btn" data-reviewback aria-label="Back">${I.back}</button><h1>Confirm</h1><span class="head-sp"></span></div>
    <section class="card review">
      <p class="hero-label">${b.toSelf ? 'You are shielding' : 'You are sending'}</p>
      <p class="hero-bal">${fmtBtc(b.amount)} <small>${unit()}</small></p>
      <div class="kv">
        ${rowKV('From', b.from === 'shielded' ? `${shieldLogo}Shielded` : `${btcLogo}Public`)}
        ${rowKV('To', toTxt)}
        ${b.toSelf ? '' : rowKV('Privacy', b.kind === 'shielded' ? '<span class="good">Private — recipient address is hidden</span>' : '<span class="meh">Public address</span>')}
        ${rowKV('Network fee', `${fmtBtc(b.fee)} ${unit()}`)}
        ${rowKV('Total', `<b>${fmtBtc(b.amount + b.fee)} ${unit()}</b>`)}
      </div>
      ${statusLine('send')}
      <button class="btn primary wide" id="btnConfirmSend" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Sending…' : b.toSelf ? 'Confirm & shield' : 'Confirm & send'}</button>
      <details class="adv"><summary>Transaction details</summary>
        <div class="kv small">${rowKV('Txid', `<span class="mono">${short(b.txid, 8)}</span>`)}${rowKV('Coin used', `<span class="mono">${short(b.coin.txid, 6)}:${b.coin.vout}</span>`)}</div>
        <textarea rows="3" class="mono" readonly>${b.hex}</textarea>${copyBtn(b.hex, 'Copy raw tx')}
      </details>
    </section>`;
}
function viewDone(title, sub, txid, extra = '') {
  return `
    <section class="done">
      <div class="done-ic">${I.check}</div>
      <h1>${title}</h1>
      <p>${sub}</p>
      ${extra ? `<p class="muted small">${extra}</p>` : ''}
      <a class="btn ghost" href="${mempoolTxUrl(txid)}" target="_blank" rel="noopener">View on mempool ${I.ext}</a>
      <button class="btn primary wide" data-go="home" data-reset>Done</button>
    </section>`;
}

const OP_TITLE = { mint: 'Mint', predeploy: 'Reserve ticker', deploy: 'Deploy BRC2.0', tsend: 'Send', transfer: 'Inscribe transfer' };
function brc2NetNote() {
  if (state.net === 'signet' || state.net === 'main') return '';
  return `<div class="testnet-note warn-box"><span class="dot-warn"></span><span>BRC2.0 runs on <b>Signet</b>. ${NETS[state.net].name} indexers won't see it.</span><button class="btn ghost sm" data-setnet="signet">Switch</button></div>`;
}
function viewTokenSendReview(b) {
  return `
    <div class="view-head"><button class="icon-btn" data-mintback aria-label="Back">${I.back}</button><h1>Confirm</h1><span class="head-sp"></span></div>
    <section class="card review">
      <p class="hero-label">Sending ${isV2(b.tick) ? 'BRC2.0' : 'BRC-20'}</p>
      <p class="hero-bal">${esc(Number(b.amt).toLocaleString())} <small>${esc(b.tick.toUpperCase())}</small></p>
      <div class="kv">
        ${rowKV('To', b.toOwn ? `${shieldLogo}<b>My wallet</b>` : `<span class="mono">${esc(short(b.to, 10))}</span>`)}
        ${rowKV('Privacy', b.toKind === 'shielded' ? '<span class="good">Shielded: lands on a one-time address</span>' : '<span class="meh">Public address</span>')}
        ${rowKV('Tokens from', b.fromKind === 'shielded' ? `${shieldLogo}Shielded` : `${btcLogo}Public`)}
        ${rowKV('Fees paid from', b.from === 'shielded' ? `${shieldLogo}Shielded` : `${btcLogo}Public`)}
        ${rowKV('Network fee', `${fmtBtc(b.sendTotalFee)} ${unit()}`)}
        ${rowKV('Delivered with', `${fmtBtc(TRANSFER_POSTAGE)} ${unit()}`)}
        ${rowKV('Total', `<b>${fmtBtc(b.sendTotalFee + TRANSFER_POSTAGE)} ${unit()}</b>`)}
      </div>
      <p class="info">3 transactions: inscribe the transfer on the address holding your ${esc(b.tick.toUpperCase())}, then deliver it. Your mint coin is not touched.</p>
      ${statusLine('mint')}
      <button class="btn primary wide" id="btnConfirmMint" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Sending…' : 'Confirm · Send'}</button>
      <details class="adv"><summary>Transaction details</summary>
        <p class="mono small wrapall">${esc(b.body)}</p>
        <div class="kv small">${rowKV('Commit', `<span class="mono">${short(b.commitTxid, 8)}</span>`)}${rowKV('Inscribe', `<span class="mono">${short(b.revealTxid, 8)}</span>`)}${rowKV('Deliver', `<span class="mono">${short(b.sendTxid, 8)}</span>`)}</div>
      </details>
    </section>`;
}
function viewMintReview(b) {
  if (b.op === 'tsend') return viewTokenSendReview(b);
  const head = b.op === 'transfer'
    ? `<p class="hero-label">Inscribe transfer</p><p class="hero-bal">${esc(Number(b.amt).toLocaleString())} <small>${esc(b.tick.toUpperCase())}</small></p>`
    : b.op === 'mint'
    ? `<p class="hero-label">Minting ${isV2(b.tick) ? 'BRC2.0' : 'BRC-20'}</p><p class="hero-bal">${esc(Number(b.amt).toLocaleString())} <small>${esc(b.tick.toUpperCase())}</small></p>`
    : `<p class="hero-label">${b.op === 'predeploy' ? 'Step 1 · Reserve ticker' : 'Step 2 · Deploy'}</p><p class="hero-bal">${esc(b.tick.toUpperCase())}</p>`;
  return `
    <div class="view-head"><button class="icon-btn" data-mintback aria-label="Back">${I.back}</button><h1>Confirm</h1><span class="head-sp"></span></div>
    <section class="card review">
      ${head}
      <div class="kv">
        ${b.op !== 'mint' && b.op !== 'transfer' ? rowKV('Max supply', esc(Number(b.max).toLocaleString())) + ((b.selfMint || deploys().find((d) => d.tick === b.tick)?.selfMint) ? rowKV('Who can mint', `${I.lock} Only you`) : rowKV('Per mint', esc(b.lim))) : ''}
        ${b.op === 'mint' && b.selfMint ? rowKV('Authorised by', `${I.lock} your deploy inscription`) : ''}
        ${rowKV('Pay from', b.from === 'shielded' ? `${shieldLogo}Shielded` : `${btcLogo}Public`)}
        ${rowKV(b.op === 'predeploy' ? 'Reservation to' : 'Receive to', b.toSelf ? `${shieldLogo}<b>My Shielded</b>` : b.recipient === pubAddr() ? `${btcLogo}<b>My Public</b>` : `<span class="mono">${esc(short(b.recipient, 10))}</span>`)}
        ${rowKV('Network fee', `${fmtBtc(b.estimate.totalFee)} ${unit()}`)}
        ${rowKV('Inscription', `${fmtBtc(b.estimate.revealValue)} ${unit()}`)}
        ${rowKV('Total', `<b>${fmtBtc(b.estimate.totalFee + b.estimate.revealValue)} ${unit()}</b>`)}
      </div>
      ${b.op === 'predeploy' ? `<p class="info">Your ticker stays secret until step 2. After this confirms, wait ${PREDEPLOY_DELAY} blocks, then deploy.</p>` : ''}
      ${statusLine('mint')}
      <button class="btn primary wide" id="btnConfirmMint" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Sending…' : `Confirm · ${OP_TITLE[b.op]}`}</button>
      <details class="adv"><summary>Transaction details</summary>
        <p class="mono small wrapall">${esc(b.body)}</p>
        <div class="kv small">${rowKV('Commit', `<span class="mono">${short(b.commitTxid, 8)}</span>`)}${rowKV('Reveal', `<span class="mono">${short(b.revealTxid, 8)}</span>`)}</div>
        <div class="row">${copyBtn(b.commitHex, 'Commit hex')}${copyBtn(b.revealHex, 'Reveal hex')}</div>
      </details>
    </section>`;
}
function deployCard(d) {
  const st = deployStage(d);
  const full = d.selfMint && st.key === 'deployed' && Number(d.max) - mintedSoFar(d.tick) <= 0;
  return `<div class="dep ${st.key}">
    <div class="dep-h"><span class="tok">${esc(d.tick.toUpperCase())}</span><span class="badge v2">BRC2.0</span><span class="head-sp"></span>
      ${st.key === 'deployed' ? `<span class="good small">${I.check}</span>` : ''}</div>
    <div class="steps2">
      <span class="s2 done">1 · Reserved</span><span class="s2 ${st.key === 'deployed' ? 'done' : st.key === 'ready' ? 'on' : ''}">2 · Deploy</span><span class="s2 ${full ? 'done' : st.key === 'deployed' ? 'on' : ''}">3 · Mint</span>
    </div>
    <p class="small muted">${st.text} · max ${esc(Number(d.max).toLocaleString())}${d.selfMint ? ` · <span class="good">${I.lock} only you can mint</span>` : ` · ${esc(d.lim)} per mint`}</p>
    ${st.key === 'ready' ? `<button class="btn primary wide" data-deploy="${esc(d.tick)}">Deploy ${esc(d.tick.toUpperCase())}</button>` : ''}
    ${st.key === 'deployed' && d.selfMint ? (() => { const left = Number(d.max) - mintedSoFar(d.tick); return left > 0 ? `<button class="btn primary wide" data-mintall="${esc(d.tick)}">Mint all ${left.toLocaleString()} ${esc(d.tick.toUpperCase())}</button>` : `<p class="good small">${I.check} Full supply minted — ${Number(d.max).toLocaleString()} ${esc(d.tick.toUpperCase())} in your wallet</p>`; })() : ''}
    ${st.key === 'deployed' ? `<div class="row">${full ? '' : `<button class="btn ${d.selfMint ? 'ghost' : 'primary'} sm" data-mintof="${esc(d.tick)}">Mint ${esc(d.tick.toUpperCase())}</button>`}<a class="btn ghost sm" href="${mempoolTxUrl(d.deployTxid)}" target="_blank" rel="noopener">View ${I.ext}</a></div>` : ''}
    ${st.key === 'wait' ? `<a class="small link" href="${mempoolTxUrl(d.predeployTxid)}" target="_blank" rel="noopener">View reservation</a>` : ''}
  </div>`;
}
function viewMint() {
  const m = state.mint;
  if (m.stage === 'done' && m.built) {
    const b = m.built;
    if (b.op === 'predeploy') return viewDone('Ticker reserved', `${esc(b.tick.toUpperCase())} is reserved. Come back after ${PREDEPLOY_DELAY} blocks to deploy it.`, b.revealTxid, 'Progress shows on the Deploy tab.');
    if (b.op === 'transfer') return viewDone('Transfer inscribed', `${esc(Number(b.amt).toLocaleString())} ${esc(b.tick.toUpperCase())} is ready to list on a marketplace or send.`, b.revealTxid, 'Marketplaces show it once it confirms.');
    if (b.op === 'tsend') return viewDone('Tokens sent', `${esc(Number(b.amt).toLocaleString())} ${esc(b.tick.toUpperCase())} is on its way${b.toKind === 'shielded' ? ' to a shielded address' : ''}.`, b.sendTxid, 'Indexers update the balance once it confirms.');
    if (b.op === 'deploy') return viewDone(`${esc(b.tick.toUpperCase())} deployed`, 'Your BRC2.0 token exists. You can mint it now.', b.revealTxid, 'Indexers can take a few blocks to list it.');
    return viewDone('Mint submitted', `${esc(b.amt)} ${esc(b.tick.toUpperCase())}${b.toSelf ? ' will land in your Shielded balance.' : ' is on its way.'}`, b.revealTxid, 'Indexers can take a few blocks to show balances.');
  }
  if (m.stage === 'review' && m.built) return viewMintReview(m.built);
  const mode = state.f.mintMode;
  const fromSeg = (name) => seg(name, state.f[name], [['public', `Public · ${spendLabel('public')}`], ['shielded', `${I.shieldPlain} Shielded · ${spendLabel('shielded')}`]]);
  const top = mode === 'send'
    ? `<div class="view-head"><button class="icon-btn" data-tok="${esc(state.f.tsTick || '')}" aria-label="Back">${I.back}</button><h1>Send ${esc(String(state.f.tsTick || '').toUpperCase())}</h1><span class="head-sp"></span></div>`
    : `${head('Mint & deploy')}${seg('mintMode', mode, [['mint', 'Mint'], ['deploy', 'Deploy BRC2.0']])}`;
  if (mode === 'send') return `${top}${tokenSendView()}`;
  if (mode === 'transfer') return `<div class="view-head"><button class="icon-btn" data-tok="${esc(state.f.trTick || '')}" aria-label="Back">${I.back}</button><h1>Inscribe ${esc(String(state.f.trTick || '').toUpperCase())}</h1><span class="head-sp"></span></div>${transferView()}`;
  if (mode === 'deploy') {
    const list = deploys();
    const tickOk = /^[a-z0-9-]{0,6}$/i.test(state.f.depTick);
    return `${top}
      ${brc2NetNote()}
      ${orphanReservations().map((c) => `<section class="card form orphan">
        <p class="card-title">Finish this reservation</p>
        <p class="info">Found a ticker reservation (<span class="mono">${short(c.txid, 6)}:${c.vout}</span>) with no saved details in this browser. Enter its ticker and supply to continue.</p>
        <label class="field"><span class="lbl">Ticker</span><input data-bind="recTick" value="${esc(state.f.recTick)}" maxlength="6" autocomplete="off" spellcheck="false" placeholder="the 6-letter ticker you reserved"></label>
        <div class="field"><span class="lbl">Who can mint</span>${seg('depWho', state.f.depWho, [['self', `${I.lock} Only me`], ['open', 'Anyone']])}</div>
        <div class="${state.f.depWho === 'self' ? '' : 'row2'}">
          <label class="field"><span class="lbl">Max supply</span><input data-bind="depMax" inputmode="decimal" value="${esc(state.f.depMax)}" autocomplete="off"></label>
          ${state.f.depWho === 'self' ? '' : `<label class="field"><span class="lbl">Per mint</span><input data-bind="depLim" inputmode="decimal" value="${esc(state.f.depLim)}" autocomplete="off"></label>`}
        </div>
        <details class="adv"><summary>I have the salt</summary><input data-bind="recSalt" class="mono" value="${esc(state.f.recSalt)}" placeholder="32 hex characters" spellcheck="false"></details>
        ${statusLine('recover')}
        <button class="btn primary wide" data-recover="${c.txid}:${c.vout}">Recover reservation</button>
      </section>`).join('')}
      ${list.length ? `<section class="deps">${list.map(deployCard).join('')}</section>` : ''}
      <section class="card form">
        <p class="card-title">New BRC2.0 token</p>
        <label class="field"><span class="lbl">Ticker <span class="lbl-r">${tickLen(state.f.depTick || '')}/6</span></span><input data-bind="depTick" value="${esc(state.f.depTick)}" maxlength="6" autocomplete="off" spellcheck="false" placeholder="e.g. masked" class="${tickOk ? '' : 'bad'}"></label>
        <div class="field"><span class="lbl">Who can mint</span>${seg('depWho', state.f.depWho, [['self', `${I.lock} Only me`], ['open', 'Anyone']])}
          <span class="addr-kind ${state.f.depWho === 'self' ? 'k-shielded' : 'k-public'}">${state.f.depWho === 'self' ? 'Self-mint · you mint the whole supply and hand it out yourself' : 'Open mint · anyone can mint up to the per-mint limit'}</span></div>
        <div class="${state.f.depWho === 'self' ? '' : 'row2'}">
          <label class="field"><span class="lbl">Max supply</span><input data-bind="depMax" inputmode="decimal" value="${esc(state.f.depMax)}" autocomplete="off"></label>
          ${state.f.depWho === 'self' ? '' : `<label class="field"><span class="lbl">Per mint</span><input data-bind="depLim" inputmode="decimal" value="${esc(state.f.depLim)}" autocomplete="off"></label>`}
        </div>
        <div class="field"><span class="lbl">Reservation goes to</span>${seg('depResTo', state.f.depResTo, [['shielded', `${I.shieldPlain} Shielded`], ['public', 'Public']])}
          <span class="addr-kind ${state.f.depResTo === 'shielded' ? 'k-shielded' : 'k-public'}">${state.f.depResTo === 'shielded' ? 'Fully private · needs 2 coins (one pays, one anchors)' : 'Simplest · reservation is visible on your Public address'}</span></div>
        <div class="field"><span class="lbl">Pay from</span>${fromSeg('depFrom')}</div>
        <div class="field"><span class="lbl">Network fee</span>${feeChips()}</div>
        <p class="info">Two steps: <b>reserve</b> the ticker (kept secret), wait ${PREDEPLOY_DELAY} blocks, then <b>deploy</b>. Your token's deploy lands in your Shielded address.</p>
        ${statusLine('mint')}
        <button class="btn primary wide" id="btnReviewPredeploy">Step 1 · Reserve ticker</button>
      </section>`;
  }
  const v2 = isV2(state.f.mintTick.trim().toLowerCase());
  const toks = knownTokens();
  const cur = state.f.mintTick.trim().toLowerCase();
  return `${top}
    ${v2 ? brc2NetNote() : netBanner()}
    ${(() => { const pend = deploys().filter((d) => d.status !== 'deployed'); const orph = orphanReservations().length; return pend.length || orph ? `<button class="hint hint-cta" data-set="mintMode" data-val="deploy"><span class="hint-ic">${I.mint}</span><span><b>${pend.length ? pend.map((d) => esc(d.tick.toUpperCase())).join(', ') + ' is not deployed yet' : 'You have an unfinished reservation'}</b><span>Finish it on the Deploy BRC2.0 tab, then mint here.</span></span><span class="chev">›</span></button>` : ''; })()}
    ${toks.length ? `<div class="chips">${toks.map((t) => `<button class="chip ${t.tick === cur ? 'on' : ''}" data-pick="${esc(t.tick)}"><b>${esc(t.tick.toUpperCase())}</b><span>${t.mints ? `${t.minted.toLocaleString()} minted` : t.deployed ? 'deployed' : 'in wallet'}</span></button>`).join('')}</div>` : ''}
    <section class="card form">
      <div class="row2">
        <label class="field"><span class="lbl">Ticker <span class="lbl-r">${v2 ? '<span class="badge v2">BRC2.0</span>' : tickLen(state.f.mintTick.trim()) === 4 ? '<span class="badge">BRC-20</span>' : ''}</span></span><input data-bind="mintTick" value="${esc(state.f.mintTick)}" maxlength="6" autocomplete="off" spellcheck="false" placeholder="ticker"></label>
        <label class="field"><span class="lbl">Amount</span><input data-bind="mintAmt" inputmode="decimal" value="${esc(state.f.mintAmt)}" autocomplete="off"></label>
      </div>
      ${supplyLine(cur)}
      ${mintBlock(cur) ? `<p class="info warn">${esc(mintBlock(cur))}</p>` : ''}
      <div class="field"><span class="lbl">Receive to</span>${seg('mintTo', state.f.mintTo, [['self', `${I.shieldPlain} My Shielded`], ['other', 'Other address']])}
        ${state.f.mintTo === 'other' ? `<input data-bind="mintOther" class="mono" spellcheck="false" autocomplete="off" value="${esc(state.f.mintOther)}" placeholder="Bitcoin or shielded address"><span class="addr-kind k-${addrKind(state.f.mintOther).kind}" id="mintKind">${esc(addrKind(state.f.mintOther).text || '')}</span>` : '<span class="addr-kind k-shielded">Private — nobody can link the mint to you</span>'}
      </div>
      <div class="field"><span class="lbl">Pay from</span>${fromSeg('mintFrom')}</div>
      <div class="field"><span class="lbl">Network fee</span>${feeChips()}</div>
      ${statusLine('mint')}
      <button class="btn primary wide" id="btnReviewMint" ${mintBlock(cur) ? 'disabled' : ''}>${mintBlock(cur) && tickInfo(cur)?.data?.soldOut ? 'Sold out' : 'Review mint'}</button>
    </section>
    ${mintHistory()}`;
}
function mintHistory() {
  const list = mints();
  if (!list.length) return '';
  const all = [...state.coins, ...state.fundingCoins];
  return `<section class="card list">
    <div class="list-h"><b>Minted</b><span class="muted small">${list.length} mint${list.length === 1 ? '' : 's'}</span></div>
    ${list.map((m) => {
      const held = all.find((c) => c.txid === m.revealTxid && c.vout === m.revealOut);
      const where = m.to === 'shielded' ? shieldLogo : m.to === 'public' ? btcLogo : `<span class="coin ext">${I.send}</span>`;
      const status = m.height ? `Confirmed · block ${m.height.toLocaleString()}` : 'Pending';
      return `<div class="coin-row">${where}
        <span class="bal-txt"><b>${esc(m.tick.toUpperCase())} ${isV2(m.tick) ? '<span class="badge v2">BRC2.0</span>' : '<span class="badge">BRC-20</span>'}</b><span>${status} · ${ago(m.at)}${held ? ` · <span class="good">${I.lock} safe</span>` : m.to === 'other' ? ' · sent out' : ''}</span></span>
        <span class="bal-amt"><b>${esc(Number(m.amt).toLocaleString())}</b><span class="row-links"><a href="${inscUrl(m.inscriptionId)}" target="_blank" rel="noopener">Inscription</a><a href="${mempoolTxUrl(m.revealTxid)}" target="_blank" rel="noopener">Tx</a></span></span>
      </div>`;
    }).join('')}
  </section>`;
}

function coinInsc(c) {
  let ins = inscOf(c);
  if (ins?.brc20 && !ins.tick) {
    // a reservation read from the chain only carries a hash — get the ticker from our own deploy records
    const d = deploys().find((x) => x.predeployTxid === c.txid || x.deployTxid === c.txid || x.loc?.txid === c.txid);
    if (d) ins = { ...ins, tick: d.tick };
  }
  return ins;
}
const fmtTok = (v) => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString() : esc(String(v ?? '')); };
/** What a coin is, in plain words: { title, sub, amt (token amount line), group } */
function coinTag(c, kind) {
  const ins = coinInsc(c);
  const T = ins?.tick ? esc(ins.tick.toUpperCase()) : '';
  const badge = ins?.brc20 ? (ins.op === 'predeploy' || isV2(ins.tick) ? '<span class="badge v2">BRC2.0</span>' : '<span class="badge">BRC-20</span>') : '';
  if (ins?.brc20) {
    if (ins.op === 'mint') return { title: `Minted ${T}`, badge, amt: `<b class="pos">+${fmtTok(ins.amt)}</b><span>${T}</span>`, group: 'tokens' };
    if (ins.op === 'transfer' && transfers().some((x) => x.sendTxid === c.txid)) return { title: `Moved ${T}`, badge, amt: `<b>${fmtTok(ins.amt)}</b><span>to yourself</span>`, group: 'tokens' };
    if (ins.op === 'transfer' && ins.received) return { title: `Received ${T}`, badge, amt: `<b class="pos">+${fmtTok(ins.amt)}</b><span>${T}</span>`, group: 'tokens' };
    if (ins.op === 'transfer') return { title: `${T} transfer`, badge, amt: `<b>${fmtTok(ins.amt)}</b><span>${ins.ready ? 'ready to list or send' : 'not delivered'}</span>`, group: 'tokens' };
    if (ins.op === 'deploy') return { title: `${T} deploy`, badge, amt: `<b class="dim">No tokens</b><span>${ins.max ? `max ${fmtTok(ins.max)}` : 'kept for minting'}</span>`, group: 'deploy' };
    if (ins.op === 'predeploy') return { title: `${T ? T + ' ' : ''}ticker reservation`, badge, amt: '<b class="dim">No tokens</b><span>kept safe</span>', group: 'deploy' };
    return { title: `${T} ${esc(ins.op)}`, badge, amt: '', group: 'deploy' };
  }
  const o = ordOf(c);
  if (o && (o.ins || o.runes)) return { title: o.runes && !o.ins ? 'Runes' : 'Inscription', badge: '<span class="badge">ord</span>', amt: '', group: 'other' };
  if (c.sats != null && c.sats <= INSCRIPTION_MAX) return { title: ins && !ins.unknown && ins.contentType ? `Inscription · ${esc(ins.contentType.split(';')[0])}` : 'Small coin', badge: '', amt: '', group: 'other' };
  return { title: kind === 'public' ? 'Public' : 'Shielded', badge: '', amt: '', group: 'btc' };
}
function coinRow(c, kind) {
  const outAddr = kind === 'public' ? c.address : trAddress(c.output);
  const t = coinTag(c, kind);
  const op = `${c.txid}:${c.vout}`, auto = autoProtected(c), locked = auto || locks().has(op);
  const ins = inscOf(c);
  const where = kind === 'public' ? 'Public' : 'Shielded';
  const lockBtn = `<button class="lock ${locked ? 'on' : ''}" data-lock="${op}" ${auto ? 'disabled' : ''} title="${auto ? 'Holds an inscription — always protected' : locked ? 'Unlock coin' : 'Lock coin so it is never spent'}" aria-label="Lock">${locked ? I.lock : I.unlock}</button>`;
  const links = `<span class="row-links">${ins?.id ? `<a href="${inscUrl(ins.id)}" target="_blank" rel="noopener">Inscription</a>` : `<a href="${ordinalAddressUrl(outAddr)}" target="_blank" rel="noopener">Ordinals</a>`}<a href="${mempoolTxUrl(c.txid)}" target="_blank" rel="noopener">Tx</a></span>`;
  const state1 = c.pending ? '<em class="pend">pending</em>' : '';
  if (t.amt) {
    // inscription coin: token amount first, the sats it sits on second
    return `<div class="coin-row ins ${locked ? 'locked' : ''}">
      ${kind === 'public' ? btcLogo : shieldLogo}
      <span class="bal-txt"><b>${t.title} ${t.badge}${state1}</b><span class="small muted">${where} · ${c.pending ? 'waiting for a block' : 'confirmed'}</span>
        <span class="safe">${I.lock} Protected · ${fmtTok(c.sats)} sats</span></span>
      <span class="bal-amt tok-amt">${t.amt}${links}</span>
    </div>`;
  }
  return `<div class="coin-row ${locked ? 'locked' : ''}">
    ${kind === 'public' ? btcLogo : shieldLogo}
    <span class="bal-txt"><b>${t.title} ${t.badge}${state1}${c.example ? '<em class="pend">demo</em>' : ''}</b><span class="mono">${short(c.txid, 6)}:${c.vout}</span>
      ${locked ? `<span class="safe">${I.lock} ${auto ? 'Protected' : 'Locked'}</span>` : unverified(c) ? '<span class="small pend-t">checking with ord…</span>' : needsOrd(c) && ordOf(c) ? '<span class="small muted">plain bitcoin · checked by ord</span>' : ''}</span>
    <span class="bal-amt"><span class="amt-row"><b>${fmtBtc(c.sats)}</b>${lockBtn}</span>${links}</span>
  </div>`;
}

// ---------- Send BRC-20 / BRC2.0 tokens ----------
// A BRC-20 balance sits on the exact script that received the mint. Sending works in two inscription steps:
//   1. inscribe {"op":"transfer"} ONTO that same script (commit + reveal)
//   2. send that inscription to the recipient (first output)
// The reveal output carries a little extra so step 2 pays its own fee: no extra coin is needed and
// the original mint coin is never touched.
const xferKey = () => `wren.transfers.${walletId()}`;
function transfers() { try { return JSON.parse(localStorage.getItem(xferKey()) || '[]'); } catch { return []; } }
function saveTransfers(l) { try { localStorage.setItem(xferKey(), JSON.stringify(l.slice(0, 300))); } catch {} }
function mintSpk(r) {
  if (r.pkscript) return r.pkscript;
  const c = [...state.coins, ...state.fundingCoins].find((x) => x.txid === r.revealTxid && x.vout === r.revealOut);
  return c ? toHex(p2trScript(c.output)) : null;
}
/** Where this wallet holds a ticker, per script (what BRC-20 calls the "wallet"). */
function tokenHoldings(tick) {
  const m = new Map();
  const add = (spk, v) => spk && m.set(spk, (m.get(spk) || 0) + v);
  for (const r of mints()) if (r.tick === tick) add(mintSpk(r), Number(r.amt) || 0);
  // Also trust the chain: any coin we hold that carries a mint inscription counts, even if this
  // browser lost its mint history (reinstall, cleared storage, restored phrase).
  const recorded = new Set(mints().map((r) => r.revealTxid));
  for (const c of [...state.coins, ...state.fundingCoins]) {
    const i = inscOf(c);
    if (i?.brc20 && i.op === 'mint' && i.tick === tick && !recorded.has(c.txid)) add(toHex(p2trScript(c.output)), Number(i.amt) || 0);
    // tokens someone sent us: the balance now sits on the script that received the transfer
    if (i?.brc20 && i.op === 'transfer' && i.received && i.tick === tick && !transfers().some((t) => t.sendTxid === c.txid)) add(toHex(p2trScript(c.output)), Number(i.amt) || 0);
  }
  for (const t of transfers()) if (t.tick === tick) { add(t.fromSpk, -Number(t.amt)); if (t.toOwn) add(t.toSpk, Number(t.amt)); }
  const it = idxTok(tick), f = fundingInfo();
  if (it && f) { const spk = toHex(p2trScript(f.outputX)); m.set(spk, Math.max(m.get(spk) || 0, Number(it.overall) || 0)); }
  return [...m].map(([pkscript, amt]) => ({ pkscript, amt })).filter((h) => h.amt > 0);
}
const heldTotal = (tick) => tokenHoldings(tick).reduce((a, h) => a + h.amt, 0);
const heldMaxSingle = (tick) => tokenHoldings(tick).reduce((a, h) => Math.max(a, h.amt), 0);
function holderKey(spkHex) {
  const f = fundingInfo();
  if (f && spkHex === toHex(p2trScript(f.outputX))) return { priv: f.outputPriv, kind: 'public' };
  const x = spkHex.slice(4);
  const c = state.coins.find((k) => k.output === x && k.tweak);
  return c ? { priv: sp.outputPrivKey(state.wallet.bSpend, c.tweak), kind: 'shielded' } : null;
}
function ownScript(spkHex) {
  const f = fundingInfo();
  return (f && spkHex === toHex(p2trScript(f.outputX))) || state.coins.some((c) => toHex(p2trScript(c.output)) === spkHex);
}
// only: 'shielded' = take the tokens from Shielded holders only. holder: an exact holder { pkscript, amt, key }
// (the private trade address, whose balance comes from the token server).
async function buildTokenSend({ tick, amt, to, from, rate, only = null, holder = null }) {
  tick = String(tick || '').trim().toLowerCase(); checkTick(tick);
  amt = checkAmount(amt, 'Amount');
  const k = addrKind(to);
  if (k.kind !== 'public' && k.kind !== 'shielded') throw new Error(k.kind === 'empty' ? 'Enter who to send to.' : k.text + '.');
  const pubSpk = fundingInfo() ? toHex(p2trScript(fundingInfo().outputX)) : '';
  const all = holder ? [holder] : tokenHoldings(tick).filter((h) => !only || holderKey(h.pkscript)?.kind === only);
  const holds = all.map((h) => (h.pkscript === pubSpk ? { ...h, amt: Math.min(h.amt, transferAvail(tick)) } : h)).filter((h) => h.amt >= Number(amt)).sort((a, b) => a.amt - b.amt);
  if (!holds.length) {
    const max = all.reduce((a, h) => Math.max(a, h.amt), 0);
    const where = holder ? ' on your trade address' : only === 'shielded' ? ' in Shielded' : '';
    if (!where) throw new Error(max ? `You can send up to ${max.toLocaleString()} ${tick.toUpperCase()} in one transfer.` : `This wallet holds no ${tick.toUpperCase()} it can send.`);
    throw new Error(max ? `You can move up to ${max.toLocaleString()} ${tick.toUpperCase()}${where} in one transfer.` : `No ${tick.toUpperCase()}${where} that can be moved yet.`);
  }
  const h = holds[0];
  const key = h.key || holderKey(h.pkscript);
  if (!key) throw new Error('The coin holding this balance is not in the wallet yet. Tap refresh on Coins.');
  const fee2 = Math.ceil((10.5 + 57.5 + 43) * rate);
  // step 1: inscribe the transfer onto the holder script
  const ins = await buildInscription({
    from, rate, recipient: '', rawRecipientScript: fromHex(h.pkscript), revealExtra: fee2,
    body: jsonBody({ p: 'brc-20', op: 'transfer', tick, amt }), meta: { op: 'tsend', tick, amt }, postage: TRANSFER_POSTAGE,
  });
  // step 2: move the transfer inscription to the recipient
  const tIn = { txid: ins.revealTxid, vout: ins.revealOut, value: ins.estimate.revealValue, scriptPubKey: fromHex(h.pkscript) };
  const outScript = k.kind === 'shielded'
    ? p2trScript(sp.createOutputs([{ txid: tIn.txid, vout: tIn.vout, privKey: key.priv, taproot: true }], [{ txid: tIn.txid, vout: tIn.vout }], [to])[0].output)
    : outputScriptFor(to);
  const sendTx = { inputs: [tIn], outputs: [{ value: TRANSFER_POSTAGE, script: outScript }] };
  const sendHex = encodeTx({ ...sendTx, witnesses: [[await signTaprootKeySpend(sendTx, 0, key.priv)]] });
  const toSpk = toHex(outScript);
  return {
    ...ins, op: 'tsend', tick, amt, to, toKind: k.kind, fromSpk: h.pkscript, fromKind: key.kind, toSpk, toOwn: to === shieldAddr() || to === pubAddr(),
    sendHex, sendTxid: txidOf(sendTx), fee2, sendTotalFee: ins.estimate.totalFee + fee2,
  };
}

// Transfers this wallet made from the Public address that the token server may not count yet
// (it only sees them once they confirm). They are taken off "available" until the server catches up.
const pendKey = () => `wren.pendtr.${walletId()}`;
function pendingList() { try { return JSON.parse(localStorage.getItem(pendKey()) || '[]'); } catch { return []; } }
function savePending(list) { try { localStorage.setItem(pendKey(), JSON.stringify(list)); } catch {} }
function addPending(kind, tick, amt, txid) {
  const it = idxTok(tick);
  savePending([...pendingList(), { kind, tick, amt: Number(amt), txid, at: Date.now(), baseAvail: it ? Number(it.available) : null }]);
}
/** Drop entries the token server already reflects (its available balance went down), or that are old. */
function prunePending() {
  const keep = pendingList().filter((p) => {
    if (Date.now() - p.at > 3 * 864e5) return false;
    const it = idxTok(p.tick), w = idxWallet();
    if (it && p.baseAvail != null && Number(it.available) <= p.baseAvail - p.amt + 1e-9) return false;
    // confirmed a while before the server's last answer: the server has it by now
    if (p.confirmedAt && w && w.at > p.confirmedAt + 120000) return false;
    return true;
  });
  savePending(keep);
  return keep;
}
async function checkPending() {
  const list = pendingList(); let changed = false;
  for (const p of list) {
    if (p.confirmedAt) continue;
    try { const r = await fetch(`${esploraBase()}tx/${p.txid}/status`); const j = r.ok ? await r.json() : null; if (j?.confirmed) { p.confirmedAt = Date.now(); changed = true; } } catch {}
  }
  if (changed) savePending(list);
  prunePending();
}
function pendingFor(tick, kind) {
  const list = prunePending().filter((p) => p.tick === tick && (!kind || p.kind === kind));
  let n = list.reduce((a, p) => a + p.amt, 0);
  // also transfer inscriptions on the Public address that are still unconfirmed but were made before this list existed
  if (!kind || kind === 'transfer') for (const c of state.fundingCoins) {
    const i = c.pending && inscOf(c);
    if (i?.op === 'transfer' && i.ready && i.tick === tick && !list.some((p) => p.txid === c.txid)) n += Number(i.amt) || 0;
  }
  return n;
}
/** Unused transfer inscriptions this wallet holds on its Public address (the tokens are locked in them). */
function heldTransfers(tick) {
  let amt = 0; const txids = new Set();
  for (const c of state.fundingCoins) {
    const i = inscOf(c);
    if (i?.brc20 && i.op === 'transfer' && i.tick === tick && !i.received) { amt += Number(i.amt) || 0; txids.add(c.txid); }
  }
  return { amt, txids };
}
/** Tokens on the Public address that can still go into a new transfer inscription. Never more than
 *  "everything minus what is already inscribed", even if the token server has not caught up. */
function transferAvail(tick) {
  const f = fundingInfo(); if (!f) return 0;
  const it = idxTok(tick);
  const held = heldTransfers(tick);
  // pending sends, and inscriptions whose coin the wallet has not seen yet
  const extra = prunePending().filter((p) => p.tick === tick && !held.txids.has(p.txid)).reduce((a, p) => a + p.amt, 0);
  if (it) {
    const overall = Number(it.overall) || 0, avail = Number(it.available) || 0;
    return Math.max(0, Math.min(avail, overall - held.amt) - extra);
  }
  const spk = toHex(p2trScript(f.outputX));
  const base = tokenHoldings(tick).find((h) => h.pkscript === spk)?.amt || 0;
  return Math.max(0, base - held.amt - extra);
}
const inscribedFor = (tick) => {
  const held = heldTransfers(tick);
  const extra = prunePending().filter((p) => p.tick === tick && p.kind === 'transfer' && !held.txids.has(p.txid)).reduce((a, p) => a + p.amt, 0);
  return Math.max(Number(idxTok(tick)?.transferable) || 0, held.amt) + extra;
};
async function buildTransferInscribe({ tick, amt, from, rate }) {
  tick = String(tick || '').trim().toLowerCase(); checkTick(tick);
  amt = checkAmount(amt, 'Amount');
  const T = tick.toUpperCase(), avail = transferAvail(tick);
  if (Number(amt) > avail) {
    const shd = tokenHoldings(tick).filter((h) => holderKey(h.pkscript)?.kind === 'shielded').reduce((a, h) => a + h.amt, 0);
    if (!avail && shd) throw new Error(`Your ${T} are in Shielded. Marketplaces only see your Public address: send them to your Public address first.`);
    throw new Error(avail ? `Only ${avail.toLocaleString()} ${T} available on your Public address.` : `No ${T} available on your Public address.`);
  }
  const ins = await buildInscription({ from, rate, recipient: pubAddr(), body: jsonBody({ p: 'brc-20', op: 'transfer', tick, amt }), meta: { op: 'transfer', tick, amt }, postage: TRANSFER_POSTAGE });
  return { ...ins, op: 'transfer', tick, amt };
}
function transferView() {
  const tick = state.f.trTick; const T = esc(String(tick || '').toUpperCase());
  const avail = transferAvail(tick), it = idxTok(tick);
  return `<section class="card form">
      <p class="info">A <b>transfer inscription</b> locks an amount of ${T} into one inscription on your Public address. List it on a marketplace (UniSat, OKX, Magic Eden) or send it. Each one can be used once.</p>
      <div class="kv">${rowKV('Available', `<b>${avail.toLocaleString()}</b> ${T}`)}${inscribedFor(tick) ? rowKV('Already inscribed', `${inscribedFor(tick).toLocaleString()} ${T}${pendingFor(tick, 'transfer') ? ' <span class="muted small">(some confirming)</span>' : ''}`) : ''}</div>
      <label class="field"><span class="lbl">Amount <span class="lbl-r">${avail ? `<button class="link" data-trmax>Max</button>` : ''}</span></span><input data-bind="trAmt" inputmode="decimal" value="${esc(state.f.trAmt)}" autocomplete="off" placeholder="0"></label>
      <div class="field"><span class="lbl">Pay fee from</span>${seg('trFrom', state.f.trFrom, [['public', `Public · ${spendLabel('public')}`], ['shielded', `${I.shieldPlain} Shielded · ${spendLabel('shielded')}`]])}</div>
      <div class="field"><span class="lbl">Network fee</span>${feeChips()}</div>
      ${!sum(coinsFor(state.f.trFrom)) && spendLabel(state.f.trFrom) !== '…' ? `<p class="info warn">No free ${state.f.trFrom === 'shielded' ? 'Shielded' : 'Public'} bitcoin to pay the fee${state.f.trFrom === 'public' && sum(state.fundingCoins) ? ': every Public coin holds an inscription, and those are never spent for fees' : ''}. Send a little BTC (e.g. 0.0002) to your Public address.</p>` : ''}
      ${statusLine('mint')}
      <button class="btn primary wide" id="btnReviewTransfer" ${avail ? '' : 'disabled'}>Review</button>
    </section>`;
}
function tokenSendView() {
  const toks = knownTokens().map((t) => ({ ...t, held: heldTotal(t.tick) })).filter((t) => t.held > 0);
  if (!toks.length) return `<section class="card center"><p class="muted">No tokens to send yet. Mint some first.</p></section>${transferHistory()}`;
  if (!toks.some((t) => t.tick === state.f.tsTick)) state.f.tsTick = toks[0].tick;
  const tick = state.f.tsTick;
  const maxOne = heldMaxSingle(tick);
  const k = addrKind(state.f.tsTo);
  return `
    <div class="chips">${toks.map((t) => `<button class="chip ${t.tick === tick ? 'on' : ''}" data-set="tsTick" data-val="${esc(t.tick)}"><b>${esc(t.tick.toUpperCase())}</b><span>${t.held.toLocaleString()} held</span></button>`).join('')}</div>
    ${isV2(tick) ? brc2NetNote() : ''}
    <section class="card form">
      <label class="field"><span class="lbl">To</span><input data-bind="tsTo" class="mono" spellcheck="false" autocomplete="off" value="${esc(state.f.tsTo)}" placeholder="Bitcoin or shielded address">
        <span class="addr-kind k-${k.kind}" id="tsKind">${k.kind === 'empty' ? '<button class="link" data-tsself>Send to my own Shielded address</button>' : esc(k.text)}</span></label>
      <label class="field"><span class="lbl">Amount <span class="lbl-r">Available ${heldTotal(tick).toLocaleString()} ${esc(tick.toUpperCase())}</span></span>
        <div class="amount"><input data-bind="tsAmt" inputmode="decimal" autocomplete="off" value="${esc(state.f.tsAmt)}" placeholder="0"><span class="unit">${esc(tick.toUpperCase())}</span><button class="max" data-tsmax>MAX</button></div>
        ${tokenHoldings(tick).length > 1 ? `<span class="muted small">Your ${esc(tick.toUpperCase())} sits on ${tokenHoldings(tick).length} addresses. One transfer can move up to ${maxOne.toLocaleString()}.</span>` : ''}
      </label>
      <div class="field"><span class="lbl">Pay fees from</span>${seg('tsFrom', state.f.tsFrom, [['public', `Public · ${spendLabel('public')}`], ['shielded', `${I.shieldPlain} Shielded · ${spendLabel('shielded')}`]])}</div>
      <div class="field"><span class="lbl">Network fee</span>${feeChips()}</div>
      <p class="info">Sending a BRC-20 token takes 3 small transactions (inscribe the transfer, then deliver it). You approve them once.</p>
      ${statusLine('mint')}
      <button class="btn primary wide" id="btnReviewTSend">Review send</button>
    </section>
    ${transferHistory()}`;
}
function transferHistory() {
  const list = transfers();
  if (!list.length) return '';
  return `<section class="card list">
    <div class="list-h"><b>Sent</b><span class="muted small">${list.length}</span></div>
    ${list.map((t) => `<div class="coin-row">${t.toKind === 'shielded' ? shieldLogo : `<span class="coin ext">${I.send}</span>`}
      <span class="bal-txt"><b>${esc(t.tick.toUpperCase())} ${isV2(t.tick) ? '<span class="badge v2">BRC2.0</span>' : '<span class="badge">BRC-20</span>'}</b><span class="mono">→ ${esc(short(t.to, 8))}</span><span class="small muted">${ago(t.at)}${t.toKind === 'shielded' ? ' · shielded' : ''}</span></span>
      <span class="bal-amt"><b>−${esc(Number(t.amt).toLocaleString())}</b><span class="row-links"><a href="${mempoolTxUrl(t.sendTxid)}" target="_blank" rel="noopener">Tx</a></span></span>
    </div>`).join('')}
  </section>`;
}

// ---------- optional BRC-20 indexer (OPI brc20_api or MASKED UniSat cache) ----------
// BRC-20 balances live on the exact script that received each mint, so we ask the indexer about the
// Public address plus every output our mints landed on, and add them up.
const idxKey = () => `wren.indexer.${state.net}`;
// MASKED's token server is on by default for Mainnet ("off" when turned off in Settings)
const DEFAULT_TOKENS = { main: 'https://tokens.maskedwallet.com' };
const indexerUrl = () => { let v = null; try { v = localStorage.getItem(idxKey()); } catch {} return v === 'off' ? '' : v || DEFAULT_TOKENS[state.net] || ''; };
function decToRaw(v, dec = 18) {
  const [w, f = ''] = String(v || '0').trim().split('.');
  return BigInt((w || '0').replace(/\D/g, '') || '0') * 10n ** BigInt(dec) + BigInt((f.replace(/\D/g, '') + '0'.repeat(dec)).slice(0, dec) || '0');
}
function formatRaw(raw, dec = 18) {
  const s = String(raw || '0').replace(/^0+(?=\d)/, '');
  if (!dec) return BigInt(s).toLocaleString();
  const whole = s.length > dec ? s.slice(0, -dec) : '0';
  const frac = (s.length > dec ? s.slice(-dec) : s.padStart(dec, '0')).replace(/0+$/, '');
  return BigInt(whole).toLocaleString() + (frac ? '.' + frac.slice(0, 8) : '');
}
function tokenScripts(tick) {
  const out = new Set();
  const f = fundingInfo();
  if (f) out.add(toHex(p2trScript(f.outputX)));
  for (const m of mints()) {
    if (m.tick !== tick) continue;
    if (m.pkscript) out.add(m.pkscript);
    else { const c = [...state.coins, ...state.fundingCoins].find((x) => x.txid === m.revealTxid && x.vout === m.revealOut); if (c) out.add(toHex(p2trScript(c.output))); }
  }
  return [...out];
}
async function idxGet(path) {
  // never let a slow or offline indexer hang the wallet
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  let r;
  try { r = await fetch(indexerUrl().replace(/\/+$/, '') + path, { signal: ctl.signal }); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'Indexer not responding' : 'Indexer unreachable'); }
  finally { clearTimeout(timer); }
  const text = await r.text();
  let j;
  try { j = text ? JSON.parse(text) : {}; } catch { j = text; }
  if (r.status === 400 && /no balance/i.test(j.error || '')) return null;
  if (!r.ok || j.error) throw new Error(j.error || `Indexer error ${r.status}`);
  const result = j?.result ?? j;
  if (result && typeof result === 'object' && j?.validation) {
    if (Array.isArray(result)) { for (const item of result) if (item && typeof item === 'object' && !item.validation) item.validation = j.validation; }
    else if (!result.validation) result.validation = j.validation;
  }
  return result;
}
async function refreshIndexer() {
  if (!indexerUrl() || !state.wallet) { state.idx = null; return; }
  if (state.idxBusy) return;
  state.idxBusy = true;
  try { await refreshIndexerInner(); } finally { state.idxBusy = false; }
}
// Every token on the Public address, from the token server (UniSat-restored wallets hold tokens MASKED never minted)
const idxWalletKey = () => `wren.idxw.${walletId()}`;
function idxWallet() {
  if (state.idxW === undefined) { try { state.idxW = JSON.parse(localStorage.getItem(idxWalletKey()) || 'null'); } catch { state.idxW = null; } }
  return state.idxW && state.idxW.address === pubAddr() ? state.idxW : null;
}
function idxTok(tick) { return idxWallet()?.list.find((t) => String(t.ticker).toLowerCase() === tick) || null; }
async function refreshIdxWallet() {
  if (!indexerUrl() || !pubAddr()) return;
  try {
    const list = await idxGet(`/v1/brc20/wallet_tokens?address=${pubAddr()}`);
    if (!Array.isArray(list)) return;
    state.idxW = { address: pubAddr(), at: Date.now(), list: list.filter((t) => t.ticker).map((t) => ({ ...t, ticker: String(t.ticker).toLowerCase() })) };
    try { localStorage.setItem(idxWalletKey(), JSON.stringify(state.idxW)); } catch {}
  } catch {} // older token servers / OPI: no wallet list, per-token lookups still work
}
async function refreshIndexerInner() {
  const idx = { height: null, tokens: {}, validation: {}, decimals: {}, err: null, at: Date.now() };
  try {
    idx.height = Number(await idxGet('/v1/brc20/block_height'));
    await refreshIdxWallet();
    const pubSpk = fundingInfo() ? toHex(p2trScript(fundingInfo().outputX)) : '';
    for (const t of knownTokens()) {
      if (!isV2(t.tick) && tickLen(t.tick) !== 4) continue;
      let sum = 0n;
      const checks = [];
      for (const spk of tokenScripts(t.tick)) {
        const it = spk === pubSpk && idxTok(t.tick);
        if (it && it.validation?.balanceStatus === 'matched') { sum += decToRaw(it.overall, Number(it.decimals ?? 18)); checks.push(it.validation); idx.decimals[t.tick] = Number(it.decimals ?? 18); continue; }
        const b = await idxGet(`/v1/brc20/get_current_balance_of_wallet?pkscript=${spk}&ticker=${encodeURIComponent(t.tick)}&network=${state.net === 'main' ? 'main' : 'test'}`);
        // OPI answers in raw units (×10^decimals); the UniSat cache answers in token units and says so
        if (b) {
          const dec = Number(b.decimals ?? deploys().find((d) => d.tick === t.tick)?.dec ?? 18);
          sum += b.units === 'decimal' ? decToRaw(b.overall_balance, dec) : BigInt(String(b.overall_balance || '0').split('.')[0]);
          idx.decimals[t.tick] = dec; checks.push(b.validation || { balanceStatus: 'not_checked' });
        }
      }
      idx.tokens[t.tick] = sum.toString();
      idx.validation[t.tick] = checks.length && checks.every(v => v.balanceStatus === 'matched') ? 'matched' : checks.some(v => v.status === 'conflict') ? 'conflict' : checks.some(v => ['unavailable', 'syncing', 'stale', 'invalid_data'].includes(v.status)) ? 'unavailable' : 'not_checked';
    }
  } catch (e) { idx.err = /fetch|network/i.test(e.message) ? 'Indexer unreachable' : e.message; }
  if (idx.height != null && !Number.isFinite(idx.height)) idx.err = 'Indexer still starting';
  state.idx = idx;
}
async function saveIndexer(url) {
  url = String(url || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^/]+/.test(url)) throw new Error('Enter a URL like https://indexer.example.com');
  if (url && hasExt() && chrome.permissions?.request) {
    const ok = await chrome.permissions.request({ origins: [new URL(url).origin + '/*'] });
    if (!ok) throw new Error('Permission to reach that server was declined.');
  }
  try { url ? localStorage.setItem(idxKey(), url) : DEFAULT_TOKENS[state.net] ? localStorage.setItem(idxKey(), 'off') : localStorage.removeItem(idxKey()); } catch {}
  await refreshIndexer();
  if (url && state.idx?.err) throw new Error(state.idx.err);
}
function serverSection() {
  const c = customServer();
  const active = state.server || esploraBase();
  return `<section class="card menu">
    <div class="menu-row"><span>${I.globe}<b>Blockchain server</b></span><span class="small muted">${esc(srvName(active))}</span></div>
    <div class="det-body">
      <input id="srvUrl" class="mono" value="${esc(c)}" placeholder="Your own server (Esplora API), optional" spellcheck="false" autocomplete="off">
      <div class="row"><button class="btn primary sm" id="btnSrvSave">Save</button>${c ? '<button class="btn ghost sm" id="btnSrvOff">Use public servers</button>' : ''}</div>
      ${statusLine('srv')}
      <p class="lbl" style="margin-top:12px">Scan server <span class="muted small">(fast Shielded scanning)${DEFAULT_SCAN[state.net] && scanServer() === DEFAULT_SCAN[state.net] ? ' · MASKED default' : ''}</span></p>
      <input id="scanUrl" class="mono" value="${esc(scanServer())}" placeholder="https://scan.example.com (optional)" spellcheck="false" autocomplete="off">
      <div class="row"><button class="btn primary sm" id="btnScanSave">Save</button>${scanServer() ? '<button class="btn ghost sm" id="btnScanOff">Turn off</button>' : ''}${DEFAULT_SCAN[state.net] && scanServer() !== DEFAULT_SCAN[state.net] ? '<button class="btn ghost sm" id="btnScanDefault">Use MASKED default</button>' : ''}</div>
      ${statusLine('scansrv')}
      <p class="muted small">A scan server sends public data for each block, and your wallet does the private check itself. Your scan key never leaves this browser.${state.fastCrypto ? ' Fast crypto (WebAssembly) is on.' : ''}</p>
      <p class="muted small">MASKED uses ${ESPLORA[state.net].map(srvName).join(' and ')}, and switches automatically if one is busy. Add your own server (for example mempool or electrs, ending in <span class="mono">/api</span>) for speed and privacy. Saved per network.</p>
    </div>
  </section>`;
}
async function saveServer(url) {
  url = String(url || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^/]+/.test(url)) throw new Error('Enter a URL like https://mempool.example.com/api');
  if (url) {
    if (hasExt() && chrome.permissions?.request) {
      const ok = await chrome.permissions.request({ origins: [new URL(url).origin + '/*'] });
      if (!ok) throw new Error('Permission to reach that server was declined.');
    }
    const r = await timedFetch(url + '/blocks/tip/height').catch(() => null);
    if (!r || !r.ok || !/^\d+$/.test((await r.text()).trim())) throw new Error('That server did not answer like an Esplora API (/blocks/tip/height).');
  }
  try { url ? localStorage.setItem(srvKey(), url + '/') : localStorage.removeItem(srvKey()); } catch {}
  state.server = null;
}
function indexerSection() {
  const u = indexerUrl();
  const i = state.idx;
  return `<section class="card menu">
    <div class="menu-row"><span>${I.list}<b>BRC-20 indexer</b></span><span class="small ${i?.err ? 'neg' : 'muted'}">${u ? (i?.err ? 'offline' : i?.height ? `block ${i.height.toLocaleString()}` : '…') : 'off'}</span></div>
    <div class="det-body">
      <input id="idxUrl" class="mono" value="${esc(u)}" placeholder="https://your-indexer" spellcheck="false" autocomplete="off">
      <div class="row"><button class="btn primary sm" id="btnIdxSave">Save</button>${u ? '<button class="btn ghost sm" id="btnIdxOff">Turn off</button>' : ''}</div>
      ${statusLine('idx')}
      <p class="muted small">Shows reported token balances. The MASKED server compares supported balances with local OPI; transfers require separate checks. Saved per network.</p>
    </div>
  </section>`;
}
function idxLine(tick) {
  if (!indexerUrl()) return '';
  const i = state.idx;
  if (!i) return '<span class="idx-line muted">Indexer: checking…</span>';
  if (i.err) return `<span class="idx-line neg">Indexer: ${esc(i.err)}</span>`;
  const raw = i.tokens[tick];
  const dec = Number(i.decimals?.[tick] ?? deploys().find((d) => d.tick === tick)?.dec ?? 18);
  if (raw == null) return '<span class="idx-line muted">Indexer: not seen yet</span>';
  const validation = i.validation?.[tick];
  const label = validation === 'matched' ? 'OPI + UniSat balance match' : validation === 'conflict' ? 'Sources disagree — swaps paused' : validation === 'unavailable' ? 'Validation unavailable — swaps paused' : 'Indexer-reported balance';
  return `<span class="idx-line ${validation === 'conflict' || validation === 'unavailable' ? 'neg' : validation === 'matched' && raw !== '0' ? 'good' : 'muted'}">${esc(label)}: ${formatRaw(raw, dec)} · block ${i.height?.toLocaleString()}</span>`;
}
/** Everything that moved a ticker in or out of this wallet, newest first. */
function tokenLedger(tick) {
  const ev = [];
  const recorded = new Set(mints().map((m) => m.revealTxid));
  for (const m of mints()) if (m.tick === tick) ev.push({ kind: 'mint', amt: Number(m.amt) || 0, at: m.at || 0, txid: m.revealTxid, pending: !m.height, where: m.to === 'other' ? 'to someone else' : '' });
  for (const c of [...state.coins, ...state.fundingCoins]) {
    const i = coinInsc(c);
    if (!i?.brc20 || i.tick !== tick) continue;
    if (i.op === 'mint' && !recorded.has(c.txid)) ev.push({ kind: 'mint', amt: Number(i.amt) || 0, at: i.at || 0, txid: c.txid, pending: !!c.pending, where: c.kind === 'funding' ? 'Public' : 'Shielded' });
    if (i.op === 'transfer' && i.received && !transfers().some((t) => t.sendTxid === c.txid)) ev.push({ kind: 'in', amt: Number(i.amt) || 0, at: i.at || 0, txid: c.txid, pending: !!c.pending, from: i.from || '', where: c.kind === 'funding' ? 'Public' : 'Shielded' });
  }
  for (const t of transfers()) {
    if (t.tick !== tick) continue;
    // listed straight from Shielded: still yours while the listed coin is unspent, sold once it is gone
    if (t.listing) { const c = state.coins.find((x) => x.key === t.listing); ev.push({ kind: c ? 'list' : 'sold', amt: Number(t.amt) || 0, at: t.at || 0, txid: t.revealTxid, pending: !!c?.pending, where: 'Shielded' }); continue; }
    ev.push({ kind: t.toOwn ? 'move' : 'out', amt: Number(t.amt) || 0, at: t.at || 0, txid: t.sendTxid, to: t.to, pending: false, where: t.toKind === 'shielded' ? 'Shielded' : 'Public' });
  }
  ev.sort((x, y) => (y.at || Infinity) - (x.at || Infinity));
  const sum = (k) => ev.filter((e) => e.kind === k).reduce((a, e) => a + e.amt, 0);
  return { events: ev, minted: sum('mint'), received: sum('in'), sent: sum('out') + sum('sold'), listed: sum('list'), held: heldTotal(tick), pendingIn: ev.filter((e) => e.pending && (e.kind === 'in' || e.kind === 'mint')).reduce((a, e) => a + e.amt, 0) };
}
/** Tokens this wallet knows about: { tick, held, v2 } */
function tokenList() {
  const ticks = new Set(knownTokens().map((t) => t.tick));
  for (const t of transfers()) ticks.add(t.tick);
  return [...ticks].filter(Boolean).map((tick) => { const listed = tokenLedger(tick).listed; return { tick, held: heldTotal(tick) + listed, listed, v2: isV2(tick) }; }).sort((x, y) => y.held - x.held || x.tick.localeCompare(y.tick));
}
const tokBadge = (tick) => (isV2(tick) ? '<span class="badge v2">BRC2.0</span>' : '<span class="badge">BRC-20</span>');
const tokIcon = (tick, big = false) => `<span class="tok-ic ${big ? 'big' : ''}">${esc(tick.slice(0, 2).toUpperCase())}</span>`;
function tokenRows(list) {
  return list.map((t) => `<button class="tok-line" data-tok="${esc(t.tick)}">${tokIcon(t.tick)}
      <span class="bal-txt"><b class="tk">${esc(t.tick.toUpperCase())}</b><span>${t.v2 ? 'BRC2.0' : 'BRC-20'}${tokenLedger(t.tick).pendingIn ? ' · <span class="pend-t">incoming</span>' : ''}</span></span>
      <span class="bal-amt"><b>${t.held.toLocaleString()}</b><span>${t.listed ? `${t.listed.toLocaleString()} listed` : t.held ? 'in wallet' : 'none left'}</span></span><span class="chev">›</span></button>`).join('');
}
/** Home: UniSat-style token list with All / BRC-20 / BRC2.0 tabs. */
function homeTokens(side = null) {
  const all = side ? tokenList().map((t) => {
    const h = tokenHoldings(t.tick), amt = h.filter((x) => holderKey(x.pkscript)?.kind === side).reduce((a, x) => a + x.amt, 0) + (side === 'shielded' ? t.listed : 0);
    return { ...t, held: amt, listed: side === 'shielded' ? t.listed : 0 };
  }).filter((t) => t.held > 0) : tokenList();
  if (side && !all.length) return `<section class="home-toks"><div class="list-h"><b>Tokens</b><span class="muted small">${side === 'shielded' ? 'Shielded' : 'Public'}</span></div><p class="muted small center">No tokens on this side yet.</p></section>`;
  if (!all.length) return '';
  const f = state.f.homeTok || 'all';
  const v1 = all.filter((t) => !t.v2), v2 = all.filter((t) => t.v2);
  const shown = f === 'brc20' ? v1 : f === 'brc2' ? v2 : all;
  return `<section class="home-toks">
    <div class="list-h"><b>Tokens</b>${side ? `<span class="muted small">${side === 'shielded' ? 'Shielded' : 'Public'}</span>` : ''}</div>
    <div class="pills">${[['all', `All (${all.length})`], ['brc20', `BRC-20 (${v1.length})`], ['brc2', `BRC2.0 (${v2.length})`]].map(([k, l]) => `<button class="pill ${f === k ? 'on' : ''}" data-set="homeTok" data-val="${k}">${l}</button>`).join('')}</div>
    <div class="tok-list">${tokenRows(shown) || '<p class="muted small center">None yet.</p>'}</div>
  </section>`;
}
const dayLabel = (ms) => { if (!ms) return 'Earlier'; const d = new Date(ms); const t = new Date(); const y = new Date(Date.now() - 864e5); if (d.toDateString() === t.toDateString()) return 'Today'; if (d.toDateString() === y.toDateString()) return 'Yesterday'; return d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' }); };
const EV = {
  mint: { t: 'Mint', ic: 'mint', cls: 'in' },
  in: { t: 'Receive', ic: 'recv', cls: 'in' },
  out: { t: 'Send', ic: 'send', cls: 'out' },
  move: { t: 'Move', ic: 'send', cls: 'mv' },
  list: { t: 'Inscribed to sell', ic: 'list', cls: 'mv' },
  sold: { t: 'Sold', ic: 'send', cls: 'out' },
};
/** Token page: balance, where it sits, actions, History / Details. */
function viewToken() {
  const tick = state.tokTick;
  if (!tick) { state.view = 'home'; return viewHome(); }
  const T = esc(tick.toUpperCase());
  const L = tokenLedger(tick);
  const holds = tokenHoldings(tick);
  const byKind = (k) => holds.filter((h) => holderKey(h.pkscript)?.kind === k).reduce((a, h) => a + h.amt, 0);
  const pub = byKind('public'), shd = byKind('shielded');
  const tab = state.f.tokTab || 'history';
  const d = deploys().find((x) => x.tick === tick && x.status === 'deployed');
  const coins = [...state.fundingCoins.map((c) => ({ c, kind: 'public' })), ...state.coins.map((c) => ({ c, kind: 'shielded' }))].filter(({ c }) => coinInsc(c)?.tick === tick);
  const depCoin = coins.map(({ c }) => coinInsc(c)).find((i) => i?.op === 'deploy');
  const max = d?.max ?? depCoin?.max;
  // history grouped by day
  const groups = []; let cur = null;
  for (const e of [...L.events].sort((x, y) => (y.pending - x.pending) || ((y.at || 0) - (x.at || 0)))) {
    const label = e.pending ? 'Pending' : dayLabel(e.at);
    if (!cur || cur.label !== label) groups.push(cur = { label, list: [] });
    cur.list.push(e);
  }
  const who = (e) => e.kind === 'list' ? (e.pending ? 'Confirming · then it can sell' : 'Ready to sell, on a one-time address') : e.kind === 'sold' ? 'Bitcoin went to Shielded' : e.kind === 'in' ? (e.from ? `From ${esc(short(e.from, 6))}` : 'From another wallet') : e.kind === 'out' || e.kind === 'move' ? `To ${esc(short(e.to || '', 6))}` : `To your ${e.where || 'wallet'}`;
  const history = groups.length ? groups.map((g) => `<p class="h-day">${esc(g.label)}</p>${g.list.map((e) => `<a class="h-row" href="${mempoolTxUrl(e.txid)}" target="_blank" rel="noopener">
      <span class="h-ic ${EV[e.kind].cls}">${I[EV[e.kind].ic]}</span>
      <span class="bal-txt"><b>${EV[e.kind].t}${e.where && e.kind !== 'out' && e.kind !== 'sold' ? ` <span class="where ${e.where === 'Shielded' ? 'sh' : ''}">${e.where}</span>` : ''}</b><span>${who(e)}</span></span>
      <span class="h-amt ${EV[e.kind].cls}">${e.kind === 'out' || e.kind === 'sold' ? '−' : e.kind === 'move' || e.kind === 'list' ? '' : '+'}${e.amt.toLocaleString()}</span></a>`).join('')}`).join('') : '<p class="muted small center">No activity yet.</p>';
  const kv = (k, v) => `<div class="d-row"><span>${k}</span><span>${v}</span></div>`;
  const details = `<div class="d-list">
      ${kv('Ticker', T)}${kv('Standard', isV2(tick) ? 'BRC2.0 (6 letters)' : 'BRC-20')}
      ${max ? kv('Max supply', Number(max).toLocaleString()) : ''}
      ${d ? kv('Deployed by', 'You' + (d.selfMint ? ' · only you can mint' : '')) : ''}
      ${kv('Minted here', L.minted.toLocaleString())}${kv('Received', L.received.toLocaleString())}${kv('Sent', L.sent.toLocaleString())}
      ${kv('Sits on', `${holds.length} address${holds.length === 1 ? '' : 'es'}`)}
      ${indexerUrl() ? `<div class="d-row">${idxLine(tick)}</div>` : ''}
    </div>
    ${coins.length ? `<section class="card list"><div class="list-h"><b>Coins</b><span class="muted small">never spent by Send or Shield</span></div>${coins.map(({ c, kind }) => coinRow(c, kind)).join('')}</section>` : ''}`;
  return `
    <div class="tok-page">
      <div class="view-head"><button class="icon-btn" data-go="${state.tokFrom || 'home'}" aria-label="Back">${I.back}</button><span class="head-sp"></span></div>
      <div class="tok-hero">${tokIcon(tick, true)}<p class="tok-name">${T} ${tokBadge(tick)}</p><p class="tok-big">${(L.held + L.listed).toLocaleString()}</p>${L.pendingIn ? `<p class="pend-t small">+${L.pendingIn.toLocaleString()} incoming · waiting for a block</p>` : ''}</div>
      <section class="card tok-box">
        <div class="d-row"><span>In wallet</span><b>${(L.held + L.listed).toLocaleString()}</b></div>
        <div class="d-row"><span>${btcLogo} Public</span><b>${pub.toLocaleString()}</b></div>
        ${inscribedFor(tick) ? `<div class="d-row sub"><span>· inscribed, ready to list</span><span>${inscribedFor(tick).toLocaleString()}</span></div>` : ''}
        <div class="d-row"><span>${shieldLogo} Shielded</span><b class="sh-t">${(shd + L.listed).toLocaleString()}</b></div>
        ${L.listed ? `<div class="d-row sub"><span>· inscribed to sell${L.events.some((e) => e.kind === 'list' && e.pending) ? ' (confirming)' : ''}</span><span>${L.listed.toLocaleString()}</span></div>` : ''}
        <div class="tok-acts">
          <button class="tact" data-tsend="${esc(tick)}" ${L.held ? '' : 'disabled'}>${I.send}<span>Send</span></button>
          <button class="tact" data-go="receive" data-recv="shielded">${I.recv}<span>Receive</span></button>
          <button class="tact" data-tinsc="${esc(tick)}" ${transferAvail(tick) ? '' : 'disabled'} title="Inscribe a transfer to list or send">${I.list}<span>Inscribe</span></button>
          <button class="tact" data-tmint="${esc(tick)}">${I.mint}<span>Mint</span></button>
        </div>
      </section>
      <div class="tabs">${[['history', 'History'], ['details', 'Details']].map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-set="tokTab" data-val="${k}">${l}</button>`).join('')}</div>
      ${tab === 'history' ? `<section class="hist">${history}</section>` : details}
    </div>`;
}
function viewActivity() {
  const w = state.wallet;
  const p = state.scanProgress;
  const filter = state.f.coinFilter;
  const all = [...state.fundingCoins.map((c) => ({ c, kind: 'public' })), ...state.coins.map((c) => ({ c, kind: 'shielded' }))];
  const isBrc2 = ({ c }) => { const i = inscOf(c); return !!i?.brc20 && (isV2(i.tick) || i.op === 'predeploy'); };
  const isBtc = ({ c }) => c.sats == null || c.sats > INSCRIPTION_MAX;
  const shown = all.filter(filter === 'btc' ? isBtc : filter === 'brc2' ? isBrc2 : () => true);
  const count = (f) => all.filter(f).length;
  const empty = filter === 'brc2' ? 'No BRC2.0 tokens yet. Deploy or mint one from the Mint tab.' : filter === 'btc' ? 'No bitcoin yet.' : 'No coins yet. Receive some, then they show up here.';
  return `
    <div class="view-head">${back('settings')}<h1>Coins &amp; inscriptions</h1><span class="head-sp"></span><button class="icon-btn ${state.syncing ? 'spin' : ''}" id="btnSync" aria-label="Refresh">${I.refresh}</button></div>
    <p class="muted small" style="margin:-6px 2px 12px">Every coin in this wallet. Coins holding inscriptions are protected automatically. Lock any other coin to keep it from being spent.</p>
    ${seg('coinFilter', filter, [['all', `All · ${all.length}`], ['btc', `BTC · ${count(isBtc)}`], ['brc2', `BRC2.0 · ${count(isBrc2)}`]])}
    ${filter === 'brc2' && tokenList().some((t) => t.v2) ? `<section class="tok-list">${tokenRows(tokenList().filter((t) => t.v2))}</section>` : ''}
    ${filter === 'brc2' && shown.length ? (() => {
      const g = (k) => shown.filter(({ c, kind }) => coinTag(c, kind).group === k);
      const tok = g('tokens'), dep = g('deploy');
      return `${tok.length ? `<section class="card list"><div class="list-h"><b>Token coins</b><span class="muted small">hold your balance</span></div>${tok.map(({ c, kind }) => coinRow(c, kind)).join('')}</section>` : ''}
        ${dep.length ? `<section class="card list"><div class="list-h"><b>Deploy coins</b><span class="muted small">no tokens · never spent</span></div>${dep.map(({ c, kind }) => coinRow(c, kind)).join('')}</section>` : ''}`;
    })() : `<section class="card list">${shown.map(({ c, kind }) => coinRow(c, kind)).join('') || `<p class="muted center">${empty}</p>`}</section>`}
    <p class="muted small center">${syncText()}${p && p.nextHeight >= 0 && !w?.fresh ? ` · history checked back to block ${(p.nextHeight + 1).toLocaleString()}` : ''}</p>
    ${state.syncErr ? `<p class="msg err">${esc(state.syncErr)}</p>` : ''}
    <details class="card adv"><summary>Find a payment manually</summary>
      <p class="muted small">Paste a transaction's JSON from mempool.space (/api/tx/&lt;txid&gt;) to check it for shielded payments.</p>
      <textarea data-bind="scanText" rows="5" class="mono" spellcheck="false">${esc(state.f.scanText)}</textarea>
      <div class="row"><button class="btn primary sm" id="btnScan">Check</button><button class="btn ghost sm" id="btnResetScan">Reset coin list</button></div>
      ${statusLine('scan')}
    </details>`;
}

function viewSettings() {
  const w = state.wallet;
  const r = state.calc;
  return `
    <div class="view-head"><h1>Settings</h1><span class="head-sp"></span></div>
    <section class="card menu">
      <div class="menu-row"><span>${I.globe}<b>Network</b></span>
        <select id="netSel2">${Object.entries(NETS).map(([k, n]) => `<option value="${k}" ${state.net === k ? 'selected' : ''}>${n.name}</option>`).join('')}</select></div>
      ${w?.mnemonic && !state.reveal && readVault() ? `<details class="menu-det"><summary class="menu-row"><span>${I.eye}<b>Show recovery phrase</b></span><span class="chev">›</span></summary>
        <div class="det-body"><input type="password" id="pwReveal" placeholder="Enter your password" autocomplete="current-password">${statusLine('reveal')}<button class="btn primary wide" id="btnReveal">Show phrase</button></div></details>` : ''}
      ${w?.mnemonic && (state.reveal || !readVault()) ? `<button class="menu-row" id="btnReveal"><span>${I.eye}<b>${state.reveal ? 'Hide' : 'Show'} recovery phrase</b></span><span class="chev">›</span></button>
      ${state.reveal ? `<div class="secret"><p class="warn small">Anyone with these words can take your coins. Never share them.</p><ol class="words">${w.mnemonic.split(' ').map((x) => `<li>${x}</li>`).join('')}</ol>${copyBtn(w.mnemonic, 'Copy phrase')}</div>` : ''}` : ''}
    </section>
    <section class="card menu">
      <button class="menu-row" data-replace="create"><span>${I.wallet}<b>Create new wallet</b></span><span class="chev">›</span></button>
      <button class="menu-row" data-replace="restore"><span>${I.recv}<b>Restore from phrase</b></span><span class="chev">›</span></button>
    </section>
    ${hasExt() && chrome.sidePanel?.open && !new URLSearchParams(location.search).has('panel') && !reqId ? `<section class="card menu"><button class="menu-row" id="btnPanel"><span>${I.wallet}<b>Open in side panel</b></span><span class="small muted">stays open while you browse ›</span></button></section>` : ''}
    <section class="card menu">
      <button class="menu-row" data-go="activity"><span>${I.list}<b>Coins &amp; inscriptions</b></span><span class="small muted">${state.fundingCoins.length + state.coins.length} coin${state.fundingCoins.length + state.coins.length === 1 ? '' : 's'} ›</span></button>
      <details class="menu-det" data-k="rescan"><summary class="menu-row"><span>${I.refresh}<b>Rescan history</b></span><span class="small muted">${historyLeft() ? `${historyLeft().toLocaleString()} blocks left` : state.scanProgress?.nextHeight >= 0 ? `checked back to ${(state.scanProgress.nextHeight + 1).toLocaleString()}` : 'look further back'} ›</span></summary>
        <div class="det-body">
          <p class="muted small">A Shielded payment missing after a restore? Choose how far back to look. It keeps going while the wallet is open.</p>
          <div class="chips">${[['7', '1 week'], ['30', '1 month'], ['90', '3 months'], ['365', '1 year']].map(([d, l]) => `<button class="chip" data-rescan="${d}">${l}</button>`).join('')}${historyLeft() ? '<button class="chip" data-rescan="stop">Stop</button>' : ''}</div>
          ${state.net === 'main' ? '<p class="muted small">Mainnet blocks are large, so long ranges take a while on public servers. Your own server (below) is much faster.</p>' : ''}
        </div></details>
    </section>
    ${securitySection()}
    ${statusLine('wallet')}
    ${sitesSection()}
    ${tradeSection()}
    ${serverSection()}
    ${indexerSection()}
    <details class="card adv"><summary>Advanced</summary>
      ${w ? `<div class="kv small">
        ${rowKV('Wallet type', { example: 'Demo', mnemonic: 'Recovery phrase', keys: w.bSpend === null ? 'Watch-only' : 'Raw keys' }[w.source])}
        ${rowKV('Public address', `<span class="mono">${esc(short(pubAddr(), 8))}</span>`)}
        ${rowKV('Shielded address', `<span class="mono">${esc(short(shieldAddr(), 8))}</span>`)}
        ${w.source === 'mnemonic' ? rowKV('Paths', `<span class="mono">m/86'/${net().coin}'/0'/0/0 · m/352'/${net().coin}'/0'</span>`) : ''}
      </div>
      <details class="sub"><summary>Private keys</summary>
        <p class="warn small">Anyone who sees these can spend your coins.</p>
        <p class="lbl">Scan key</p><p class="mono small wrapall">${toHex(n2b(w.bScan))}</p>
        <p class="lbl">Spend key</p><p class="mono small wrapall">${w.bSpend === null ? 'Watch-only' : toHex(n2b(w.bSpend))}</p>
        ${state.coins.filter((c) => !c.example && w.bSpend !== null).map((c) => `<p class="lbl">Coin ${short(c.txid, 4)}:${c.vout} (import as rawtr)</p>${copyBtn(`rawtr(${toWif(sp.outputPrivKey(w.bSpend, c.tweak))})`, 'Copy descriptor')}`).join('')}
      </details>` : ''}
      <details class="sub"><summary>Extra shielded addresses (labels)</summary>
        ${state.labels.map((l) => { const la = address(l.m); return `<div class="label-row"><b>#${l.m} ${esc(l.note)}</b><p class="mono small wrapall">${la}</p><div class="row">${copyBtn(la)}<button class="btn ghost sm" data-dellabel="${l.m}">Remove</button></div></div>`; }).join('')}
        <div class="row2"><input id="labM" type="number" min="1" value="${Math.max(0, ...state.labels.map((l) => l.m)) + 1}"><input id="labNote" placeholder="Note, e.g. Shop"></div>
        <button class="btn ghost sm" id="btnLabel">Add label</button>
      </details>
      <details class="sub"><summary>Import raw keys</summary>
        <input id="rawScan" class="mono" spellcheck="false" autocomplete="off" placeholder="Scan private key (64 hex)">
        <input id="rawSpend" class="mono" spellcheck="false" autocomplete="off" placeholder="Spend private key or public key">
        <div class="row"><button class="btn primary sm" id="btnRaw">Load keys</button><button class="btn ghost sm" id="btnExample">Load demo wallet</button></div>
      </details>
      <details class="sub"><summary>Shielded output calculator</summary>
        <p class="muted small">Only for building a transaction in another wallet.</p>
        <div id="sendInputs">${state.sendInputs ?? inputRow()}</div>
        <button class="btn ghost sm" id="btnAddIn">Add input</button>
        <textarea data-bind="calcRecips" rows="2" class="mono" spellcheck="false" placeholder="Shielded addresses, one per line">${esc(state.f.calcRecips)}</textarea>
        <button class="btn primary sm" id="btnCalc">Work out outputs</button>
        ${r?.err ? `<p class="msg err">${esc(r.err)}</p>` : ''}
        ${r?.out ? r.out.map((o) => `<p class="mono small wrapall">${trAddress(o.output)}</p>${copyBtn(trAddress(o.output))}`).join('') + '<p class="warn small">If any input changes, work the outputs out again.</p>' : ''}
      </details>
    </details>
    <p class="muted small center">MASKED ${'2.3.3'} · keys stay in this browser</p>`;
}

const NAV = [['home', 'Wallet', I.wallet], ['mint', 'Mint', I.mint], ['settings', 'Settings', I.gear]];
const navOf = (v) => { const n = ['receive', 'send', 'shield'].includes(v) ? 'home' : v === 'token' || (v === 'mint' && (state.f.mintMode === 'send' || state.f.mintMode === 'transfer')) ? (state.tokFrom || 'home') : v; return n === 'activity' ? 'settings' : n; };
function render() {
  if ($('#sendInputs')) state.sendInputs = [...document.querySelectorAll('#sendInputs .inrow')].map((r) => inputRow({ op: r.querySelector('[data-f=op]').value, type: r.querySelector('[data-f=type]').value, key: r.querySelector('[data-f=key]').value })).join('');
  const dkey = (d) => d.dataset.k || d.querySelector('summary')?.textContent.trim() || '';
  const open = new Set([...document.querySelectorAll('#view details')].filter((d) => d.open).map(dkey));
  const focus = document.activeElement?.dataset?.bind;
  const caret = focus ? document.activeElement.selectionStart : null;
  const gate = { locked: viewLock, onboard: viewOnboard, 'onboard-cancel': viewOnboard, migrate: viewSetPassword, backup: viewBackup }[state.lockState];
  const views = { approve: viewApprove, home: viewHome, token: viewToken, receive: viewReceive, send: () => viewSend('send'), shield: () => viewSend('shield'), activity: viewActivity, mint: viewMint, settings: viewSettings };
  const prev = state.renderedView;
  $('#view').innerHTML = gate ? gate() : views[state.view]();
  if (prev === state.view) document.querySelectorAll('#view details').forEach((d) => { if (open.has(dkey(d))) d.open = true; });
  else window.scrollTo(0, 0);
  state.renderedView = state.view;
  if (focus) { const el = document.querySelector(`[data-bind="${focus}"]`); if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch {} } }
  $('#netChip').textContent = net().name;
  $('#netChip').className = `net-chip ${isTest() ? 'test' : 'main'}`;
  // header: the address of the side on show (tap to copy); words when there is no open wallet
  const hdrAddr = !gate && state.wallet && state.view !== 'approve' ? sideAddr() : '';
  $('#acctShort').innerHTML = hdrAddr ? `<button class="acct-addr ${getSide() === 'shielded' ? 'sh' : ''}" data-copy="${esc(hdrAddr)}" title="Copy your ${getSide() === 'shielded' ? 'Shielded' : 'Public'} address">${getSide() === 'shielded' ? I.shieldPlain : ''}<span>${esc(short(hdrAddr, 6))}</span>${I.copy}</button>`
    : esc(gate ? (state.lockState === 'locked' ? 'Locked' : 'Set up') : state.wallet ? (state.wallet.source === 'example' ? 'Demo wallet' : 'Account 1') : 'No wallet');
  $('#nav').style.display = gate || state.view === 'approve' ? 'none' : '';
  $('#lockBtn').hidden = !!gate || !readVault();
  publishPublic();
  publishTrade();
  $('#nav').innerHTML = NAV.map(([k, n, ic]) => `<button data-go="${k}" class="${navOf(state.view) === k ? 'on' : ''}">${ic}<span>${n}</span></button>`).join('');
  try { localStorage.setItem('wren.view', navOf(state.view)); } catch {}
}
function toast(text) {
  const t = $('#toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(state.toastT); state.toastT = setTimeout(() => t.classList.remove('show'), 1400);
}
function resetWalletState() {
  state.coins = []; state.fundingCoins = []; state.send = { stage: 'form' }; state.mint = { stage: 'form' }; state.reveal = false;
  loadScanProgress(); loadCoins();
}
function setNet(n) {
  state.net = n;
  state._insc = null;
  if (state.wallet?.source === 'mnemonic') { const { mnemonic, passphrase, fresh, birthday, restored } = state.wallet; state.wallet = walletFromMnemonic(mnemonic, passphrase); state.wallet.fresh = fresh; state.wallet.birthday = birthday; state.wallet.restored = restored; saveLocalWallet(); }
  else if (state.wallet?.source === 'example') loadExample();
  resetWalletState();
  render();
  syncChain(6);
}

// ---------- events ----------
document.addEventListener('input', (e) => {
  const b = e.target.dataset?.bind;
  if (!b) return;
  state.f[b] = e.target.value;
  if (b === 'sendTo') {
    const k = addrKind(e.target.value), el = $('#sendKind');
    if (el) { el.className = `addr-kind k-${k.kind}`; el.innerHTML = k.kind === 'empty' ? '<button class="link" data-fillself>Send to my own Shielded address</button>' : esc(k.text); }
  }
  if (b === 'tsTo') { const k = addrKind(e.target.value), el = $('#tsKind'); if (el) { el.className = `addr-kind k-${k.kind}`; el.innerHTML = k.kind === 'empty' ? '<button class="link" data-tsself>Send to my own Shielded address</button>' : esc(k.text); } }
  if (b === 'mintTick') { clearTimeout(state.tickT); state.tickT = setTimeout(() => { if (state.view === 'mint') render(); }, 450); }
  if (b === 'mintOther') { const k = addrKind(e.target.value), el = $('#mintKind'); if (el) { el.className = `addr-kind k-${k.kind}`; el.textContent = k.text || ''; } }
  if (b === 'feeCustom') {
    const el = $('#feeNote'), c = customFee(), v = e.target.value;
    if (el) { const bad = v !== '' && !c, high = c > Math.max(50, state.fees.fast * 5); el.className = `fee-note ${bad ? 'bad' : high ? 'warn' : ''}`; el.textContent = bad ? `Enter ${FEE_MIN} to ${FEE_MAX} sat/vB. Using Avg (${fmtRate(state.fees.normal)}) until then.` : high ? 'That is much higher than needed right now.' : `Using ${fmtRate(c || state.fees.normal)} sat/vB.`; }
    const cb = document.querySelector('.fee.custom'); if (cb) cb.innerHTML = `<b>Custom</b>${c ? `<span class="r"><em>${fmtRate(c)}</em> sat/vB</span>` : ''}`;
  }
  if (state.status.send) state.status.send = null;
});
document.addEventListener('change', (e) => {
  if (e.target.hasAttribute?.('data-rbf')) { RBF = e.target.checked; try { localStorage.setItem('wren.rbf', RBF ? '1' : '0'); } catch {} toast(RBF ? 'RBF on' : 'RBF off'); return; }
  if (e.target.hasAttribute?.('data-backed')) { state.f.backed = e.target.checked; render(); return; }
  if (e.target.id === 'autoLockSel') { try { localStorage.setItem('wren.autolock', e.target.value); } catch {} if (state.secret) sessionSet(state.secret); toast(`Auto-lock: ${e.target.selectedOptions[0].text}`); return; }
  if (e.target.hasAttribute?.('data-risk')) { state.f.apRisk = e.target.checked; state.status.approve = null; render(); return; }
  if (e.target.id === 'netSel2') setNet(e.target.value);
});
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  if (t.id === 'netChip') { state.view = 'settings'; render(); return; }
  if (t.hasAttribute('data-rbfinfo')) { e.preventDefault(); state.f.rbfInfo = !state.f.rbfInfo; render(); return; }
  if (t.dataset.side) { setSide(t.dataset.side); render(); return; }
  if (t.dataset.copy != null) {
    try { await navigator.clipboard.writeText(t.dataset.copy); toast('Copied'); }
    catch { toast('Copy failed — select and copy manually'); }
    return;
  }
  if (t.dataset.go) {
    if (t.dataset.recv) state.f.recvKind = t.dataset.recv;
    if (t.dataset.filter) state.f.coinFilter = t.dataset.filter;
    if (t.dataset.reset || ['send', 'shield'].includes(t.dataset.go)) { state.send = { stage: 'form' }; state.status.send = null; }
    if (t.dataset.reset || t.dataset.go === 'mint') { if (state.mint.stage === 'done') state.mint = { stage: 'form' }; state.status.mint = null; }
    // the Mint tab always opens Mint & deploy (Send / Inscribe are sub-pages of a token)
    if (t.closest('#nav') && t.dataset.go === 'mint' && ['send', 'transfer'].includes(state.f.mintMode)) { state.f.mintMode = 'mint'; state.mint = { stage: 'form' }; }
    if (t.dataset.go === 'shield') state.f.sendAmount = '';
    if (t.dataset.go === 'mint' && state.f.mintMode === 'send') state.f.mintMode = 'mint';
    state.view = t.dataset.go; if (t.dataset.go === 'settings') loadSites().then(render); render(); return;
  }
  if (t.dataset.set) { state.f[t.dataset.set] = t.dataset.val; state.status.send = null; if (t.dataset.set === 'mintMode') state.status.mint = null; render(); if (t.dataset.set === 'fee' && t.dataset.val === 'custom') $('#feeCustom')?.focus(); return; }
  if (t.hasAttribute('data-fillself')) { state.f.sendTo = shieldAddr(); render(); return; }
  if (t.dataset.max) { const m = maxSendable(state.view === 'shield' ? 'public' : t.dataset.max); state.f.sendAmount = m ? fmtBtc(m) : ''; render(); return; }
  if (t.hasAttribute('data-reviewback')) { state.send = { stage: 'form' }; render(); return; }
  if (t.hasAttribute('data-mintback')) { state.mint = { stage: 'form' }; render(); return; }
  if (t.hasAttribute('data-lock-now')) { lockNow(); return; }
  if (t.hasAttribute('data-forgot')) { state.obReturn = 'locked'; state.lockState = 'onboard-cancel'; state.f.obMode = 'restore'; render(); return; }
  if (t.hasAttribute('data-obcancel')) { state.lockState = state.obReturn || 'open'; render(); return; }
  if (t.dataset.replace) { state.obReturn = 'open'; state.lockState = 'onboard-cancel'; state.f.obMode = t.dataset.replace; state.status.onboard = null; render(); return; }
  if (t.hasAttribute('data-approve')) { approveRequest(); return; }
  if (t.hasAttribute('data-reject')) { rejectRequest(); return; }
  if (t.dataset.unsite) { await disconnectSite(t.dataset.unsite); render(); return; }
  if (t.dataset.mintall) {
    const d = deploys().find((x) => x.tick === t.dataset.mintall);
    state.f.mintMode = 'mint'; state.f.mintTick = d.tick; state.f.mintAmt = String(Number(d.max) - mintedSoFar(d.tick)); state.f.mintTo = 'self';
    try { state.mint = { stage: 'review', built: await buildMint({ from: state.f.mintFrom, tick: d.tick, amt: state.f.mintAmt, recipient: shieldAddr(), rate: feeRate() }) }; state.status.mint = null; }
    catch (err) { state.status.mint = [friendly(err.message), 'err']; }
    render(); return;
  }
  if (t.dataset.recover) {
    const [txid, vout] = t.dataset.recover.split(':');
    const coin = [...state.coins, ...state.fundingCoins].find((c) => c.txid === txid && c.vout === +vout);
    state.status.recover = ['Checking…', ''];
    render();
    try {
      const tick = await recoverReservation(coin, { tick: state.f.recTick, max: state.f.depMax, lim: state.f.depLim, selfMint: state.f.depWho === 'self', salt: state.f.recSalt });
      state.status.recover = null; state.f.recTick = ''; state.f.recSalt = '';
      toast(`${tick.toUpperCase()} reservation recovered`);
      await refreshDeploys();
    } catch (err) { state.status.recover = [friendly(err.message), 'err']; }
    render(); return;
  }
  if (t.dataset.lock) { toggleLock(t.dataset.lock); render(); return; }
  if (t.dataset.rescan === 'stop') {
    const p = { ...(state.scanProgress || {}) };
    if (Number.isInteger(p.nextHeight)) { p.floor = p.nextHeight + 1; saveScanProgress(p); }
    state.syncGen = (state.syncGen || 0) + 1; state.syncing = false; state.syncNote = '';
    toast('History scan stopped'); render(); return;
  }
  if (t.dataset.rescan) {
    const p = { ...(state.scanProgress || {}) };
    const tip = state.tip || p.topHeight;
    if (!tip) { toast('Sync first, then rescan'); return; }
    p.floor = birthdayHeight(Date.now() - Number(t.dataset.rescan) * 864e5, tip);
    if (!Number.isInteger(p.nextHeight) || p.nextHeight < p.floor) p.nextHeight = Math.min(Number.isInteger(p.nextHeight) ? p.nextHeight : tip, tip);
    if (p.nextHeight < p.floor) { toast('Already checked that far back'); return; }
    if (state.wallet) state.wallet.fresh = false;
    p.manual = true; // the person asked for this range, even before the scan server's first block
    saveScanProgress(p); toast('Rescanning…'); syncChain(12, { older: true }); render(); return;
  }
  if (t.dataset.tok) { if (state.view !== 'mint') state.tokFrom = state.view === 'activity' ? 'activity' : 'home'; state.mint = { stage: 'form' }; state.tokTick = t.dataset.tok; state.f.tokTab = 'history'; state.view = 'token'; render(); return; }
  if (t.dataset.tinsc) { if (state.view !== 'mint') state.tokFrom = state.tokFrom || 'home'; state.view = 'mint'; state.f.mintMode = 'transfer'; state.f.trTick = t.dataset.tinsc; state.f.trAmt = ''; state.mint = { stage: 'form' }; state.status.mint = null; render(); return; }
  if (t.hasAttribute?.('data-trmax')) { state.f.trAmt = String(transferAvail(state.f.trTick)); render(); return; }
  if (t.dataset.tmint) { state.view = 'mint'; state.f.mintMode = 'mint'; state.f.mintTick = t.dataset.tmint; state.mint = { stage: 'form' }; state.status.mint = null; render(); return; }
  if (t.dataset.tsend) { state.view = 'mint'; state.f.mintMode = 'send'; state.f.tsTick = t.dataset.tsend; state.mint = { stage: 'form' }; state.status.mint = null; render(); return; }
  if (t.hasAttribute('data-tsmax')) { const m = heldMaxSingle(state.f.tsTick); state.f.tsAmt = m ? String(m) : ''; render(); return; }
  if (t.hasAttribute('data-tsself')) { state.f.tsTo = shieldAddr(); render(); return; }
  if (t.dataset.pick) { state.f.mintTick = t.dataset.pick; const d = deploys().find((x) => x.tick === t.dataset.pick); if (d) state.f.mintAmt = d.selfMint ? String(Math.max(0, Number(d.max) - mintedSoFar(d.tick))) : d.lim; state.status.mint = null; render(); return; }
  if (t.dataset.setnet) { setNet(t.dataset.setnet); return; }
  if (t.dataset.mintof) { state.f.mintMode = 'mint'; state.f.mintTick = t.dataset.mintof; const d = deploys().find((x) => x.tick === t.dataset.mintof); if (d) state.f.mintAmt = d.lim; render(); return; }
  if (t.dataset.deploy) {
    try {
      const d = deploys().find((x) => x.tick === t.dataset.deploy);
      state.mint = { stage: 'review', built: await buildDeploy(d, { from: state.f.depFrom, recipient: shieldAddr(), rate: feeRate() }) };
      state.status.mint = null;
    } catch (err) { state.status.mint = [friendly(err.message), 'err']; }
    render(); return;
  }
  if (t.dataset.dellabel) { state.labels = state.labels.filter((l) => l.m !== +t.dataset.dellabel); render(); return; }
  if (t.hasAttribute('data-rmin')) { t.closest('.inrow').remove(); return; }
  try {
    switch (t.id) {
      case 'btnSync': syncChain(8); break;
      case 'btnOlder': syncChain(24, { older: true }); break;
      case 'btnReviewSend': {
        const shield = state.view === 'shield';
        state.send = { stage: 'review', built: await buildSend({ from: shield ? 'public' : state.f.sendFrom, to: shield ? 'self' : state.f.sendTo, amount: parseBtc(state.f.sendAmount), rate: feeRate() }) };
        state.status.send = null; render(); break;
      }
      case 'btnConfirmSend': {
        const b = state.send.built;
        state.busy = true; render();
        try {
          await broadcastHex(DEFAULT_BROADCAST[state.net], b.hex);
          state.send = { stage: 'done', built: b };
          state.f.sendAmount = ''; state.f.sendTo = '';
          afterBroadcast([b.coin.key], [b.txid]);
        } finally { state.busy = false; render(); }
        break;
      }
      case 'btnReviewMint': {
        const recipient = state.f.mintTo === 'self' ? shieldAddr() : state.f.mintOther.trim();
        state.mint = { stage: 'review', built: await buildMint({ from: state.f.mintFrom, tick: state.f.mintTick, amt: state.f.mintAmt, recipient, rate: feeRate() }) };
        state.status.mint = null; render(); break;
      }
      case 'btnReviewTransfer': {
        state.mint = { stage: 'review', built: await buildTransferInscribe({ tick: state.f.trTick, amt: state.f.trAmt, from: state.f.trFrom, rate: feeRate() }) };
        state.status.mint = null; render(); break;
      }
      case 'btnReviewPredeploy': {
        state.mint = { stage: 'review', built: await buildPredeploy({ from: state.f.depFrom, tick: state.f.depTick, max: state.f.depMax, lim: state.f.depLim, rate: feeRate(), resTo: state.f.depResTo, selfMint: state.f.depWho === 'self' }) };
        state.status.mint = null; render(); break;
      }
      case 'btnConfirmMint': {
        const b = state.mint.built;
        state.busy = true; render();
        try {
          const url = DEFAULT_BROADCAST[state.net];
          await broadcastHex(url, b.commitHex);
          await broadcastHex(url, b.revealHex);
          if (b.op === 'tsend') {
            await broadcastHex(url, b.sendHex);
            if (b.fromKind === 'public') addPending('send', b.tick, b.amt, b.revealTxid);
            saveTransfers([{ tick: b.tick, amt: b.amt, to: b.to, toKind: b.toKind, toSpk: b.toSpk, toOwn: b.toOwn, fromSpk: b.fromSpk, commitTxid: b.commitTxid, revealTxid: b.revealTxid, sendTxid: b.sendTxid, at: Date.now() }, ...transfers()]);
            setInsc(`${b.sendTxid}:0`, { brc20: true, op: 'transfer', tick: b.tick, amt: b.amt, id: b.inscriptionId });
            state.f.tsAmt = ''; state.f.tsTo = '';
            state.mint = { stage: 'done', built: b };
            afterBroadcast(b.spent, [b.commitTxid, b.revealTxid, b.sendTxid]);
            break;
          }
          setInsc(`${b.revealTxid}:${b.revealOut}`, { brc20: true, op: b.op, tick: b.tick, amt: b.amt, max: b.max, id: b.inscriptionId });
          if (b.op === 'mint') saveMints([{ tick: b.tick, amt: b.amt, revealTxid: b.revealTxid, revealOut: b.revealOut, pkscript: b.recipientSpk, inscriptionId: b.inscriptionId, to: b.toSelf ? 'shielded' : b.recipient === pubAddr() ? 'public' : 'other', recipient: b.recipient, at: Date.now(), height: null }, ...mints()]);
          if (b.op === 'predeploy') saveDeploys([...deploys(), { tick: b.tick, max: b.max, lim: b.lim, selfMint: !!b.selfMint, salt: b.salt, hash: b.hash, pkscript: b.pkscript, predeployTxid: b.revealTxid, predeployId: b.inscriptionId, height: null, status: 'reserved', at: Date.now() }]);
          if (b.op === 'deploy') updateDeploy(b.tick, { status: 'deployed', deployTxid: b.revealTxid, deployId: b.inscriptionId, loc: { txid: b.revealTxid, vout: b.revealOut } });
          if (b.op === 'mint' && b.selfMint) {
            // the deploy inscription came back to us in output 0
            const d = deploys().find((x) => x.tick === b.tick);
            updateDeploy(b.tick, { loc: { txid: b.revealTxid, vout: 0 } });
            setInsc(`${b.revealTxid}:0`, { brc20: true, op: 'deploy', tick: b.tick, id: d?.deployId });
          }
          if (b.op === 'deploy') setInsc(`${b.revealTxid}:0`, { brc20: true, op: 'predeploy', tick: b.tick, id: (deploys().find((d) => d.tick === b.tick) || {}).predeployId });
          if (b.op === 'predeploy') state.f.depTick = '';
          if (b.op === 'transfer') { setInsc(`${b.revealTxid}:${b.revealOut}`, { brc20: true, op: 'transfer', tick: b.tick, amt: b.amt, id: b.inscriptionId, ready: true }); addPending('transfer', b.tick, b.amt, b.revealTxid); state.f.trAmt = ''; }
          state.mint = { stage: 'done', built: b };
          afterBroadcast(b.spent, [b.commitTxid, b.revealTxid]);
        } finally { state.busy = false; render(); }
        break;
      }
      case 'btnScan': runScan(); break;
      case 'btnResetScan': {
        state.scanProgress = null; state.coins = [];
        try { localStorage.removeItem(scanStoreKey()); localStorage.removeItem(coinStoreKey()); } catch {}
        setStatus('scan', 'Coin list cleared. Tap refresh to scan again.'); break;
      }
      case 'btnReveal': await doReveal(); break;
      case 'btnUnlock': await doUnlock(); break;
      case 'btnReviewTSend': {
        state.mint = { stage: 'review', built: await buildTokenSend({ tick: state.f.tsTick, amt: state.f.tsAmt, to: state.f.tsTo, from: state.f.tsFrom, rate: feeRate() }) };
        state.status.mint = null; render(); break;
      }
      case 'btnIdxSave': {
        try { await saveIndexer($('#idxUrl').value); state.status.idx = [indexerUrl() ? `Connected · block ${state.idx?.height?.toLocaleString()}` : 'Indexer turned off.', 'ok']; }
        catch (err) { state.status.idx = [err.message, 'err']; }
        render(); break;
      }
      case 'btnSrvSave': state.status.srv = ['Checking…', '']; render(); await saveServer($('#srvUrl').value); state.status.srv = [customServer() ? 'Saved. Your server is used first.' : 'Using public servers.', 'ok']; render(); syncChain(4); break;
      case 'btnScanSave': state.status.scansrv = ['Checking…', '']; render(); await saveScanServer($('#scanUrl').value); state.status.scansrv = [scanServer() ? 'Saved. Shielded scanning now uses your scan server.' : 'Scan server off.', 'ok']; render(); break;
      case 'btnScanDefault': try { localStorage.removeItem(scanKey()); } catch {} scanInfo.at = 0; state.status.scansrv = [`Using ${srvName(DEFAULT_SCAN[state.net])}.`, 'ok']; render(); syncChain(4); break;
      case 'btnScanOff': await saveScanServer(''); state.status.scansrv = ['Scan server off.', 'ok']; render(); break;
      case 'btnSrvOff': await saveServer(''); state.status.srv = ['Using public servers.', 'ok']; render(); break;
      case 'btnPanel': {
        const w = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: w.id });
        setTimeout(() => window.close(), 100);
        break;
      }
      case 'btnIdxOff': await saveIndexer(''); state.status.idx = ['Indexer turned off.', 'ok']; render(); break;
      case 'btnOnboard': await doOnboard(); break;
      case 'btnMigrate': await doMigrate(); break;
      case 'btnChangePw': await doChangePassword(); break;
      case 'btnBackedUp': state.view = 'home'; startWallet(); break;
      case 'btnRaw': {
        const s = $('#rawScan').value.trim(), p = $('#rawSpend').value.trim();
        if (!/^[0-9a-fA-F]{64}$/.test(s)) throw new Error('Scan key must be 64 hex characters.');
        if (!/^([0-9a-fA-F]{64}|0[23][0-9a-fA-F]{64})$/.test(p)) throw new Error('Spend key must be 64-hex private or 66-hex public key.');
        state.wallet = walletFromKeys(b2n(fromHex(s)), fromHex(p), 'keys'); resetWalletState();
        setStatus('wallet', state.wallet.bSpend === null ? 'Watch-only wallet loaded.' : 'Keys loaded.', 'ok'); syncChain(6); break;
      }
      case 'btnExample': loadExample(); resetWalletState(); state.f.scanText = JSON.stringify(EXAMPLE.tx); runScan(); state.view = 'home'; render(); break;
      case 'btnLabel': {
        const m = Number($('#labM').value);
        if (!Number.isInteger(m) || m < 1 || m > 0xffffffff) throw new Error('Label number must be 1 or higher.');
        if (state.labels.some((l) => l.m === m)) throw new Error(`Label ${m} already exists.`);
        state.labels.push({ m, note: $('#labNote').value.trim() }); state.labels.sort((a, b) => a.m - b.m); render(); break;
      }
      case 'btnAddIn': $('#sendInputs').insertAdjacentHTML('beforeend', inputRow()); break;
      case 'btnCalc': { try { state.calc = { out: computeSend() }; } catch (err) { state.calc = { err: err.message }; } render(); break; }
    }
  } catch (err) {
    const key = { send: 'send', shield: 'send', mint: 'mint', settings: 'wallet', activity: 'scan' }[state.view];
    if (key) setStatus(key, friendly(err.message), 'err'); else toast(err.message);
  }
});
// Watchdog: if a sync has run far too long, release it so refresh works again.
setInterval(() => {
  if (state.syncing && Date.now() - (state.syncStart || 0) > 150000) {
    state.syncGen = (state.syncGen || 0) + 1;
    state.syncing = false; state.syncNote = ''; state.syncErr = 'Sync took too long. Tap to retry.';
    render();
  }
}, 10000);
function friendly(m) {
  if (/timeout/i.test(m)) return 'The network did not answer in time. Try again.';
  if (/insufficient fee|min relay fee|mempool min fee/i.test(m)) return 'Fee too low for the network right now. Pick a faster fee.';
  if (/bad-txns-inputs-missingorspent|missing inputs/i.test(m)) return 'That coin was already spent. Tap refresh and try again.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Could not reach the network. Check your connection.';
  return m;
}


// =====================================================================
// dApp connection (window.masked): public info, approvals and signing
// =====================================================================
const hasExt = () => typeof chrome !== 'undefined' && !!chrome.runtime?.id && !!chrome.storage?.local;
/** Running as the MASKED phone app (Capacitor), not the browser extension. */
const isApp = () => !!window.Capacitor?.isNativePlatform?.();
if (isApp() || (!hasExt() && matchMedia('(max-width: 560px)').matches)) document.documentElement.classList.add('app');
// Android back button: go back to the wallet home, and leave the app from there
if (isApp()) window.Capacitor.Plugins?.App?.addListener?.('backButton', () => {
  if (state.view !== 'home' && !['locked', 'onboard', 'backup'].includes(state.lockState)) { state.view = 'home'; state.send = { stage: 'form' }; state.mint = { stage: 'form' }; render(); }
  else window.Capacitor.Plugins.App.minimizeApp?.();
});
const UNISAT_NET = { main: 'livenet', signet: 'testnet' };
const btcNet = () => (state.net === 'main' ? btc.NETWORK : btc.TEST_NETWORK);

/** What dApps may see: the Public account. Shared through chrome.storage so the background can answer read-only calls. */
function publishPublic() {
  if (!hasExt() || !state.wallet || state.wallet.source === 'example') return;
  const f = fundingInfo();
  if (!f) return;
  const pub = { net: state.net, address: f.address, publicKey: '02' + f.internalX, xonly: f.internalX, shieldedAddress: shieldAddr() };
  const key = JSON.stringify(pub);
  if (key === state._published) return;
  state._published = key;
  chrome.storage.local.set({ 'masked.public': { ...pub, updatedAt: Date.now() } }).catch(() => {});
}
async function loadSites() {
  if (!hasExt()) return;
  try { state.sites = (await chrome.storage.local.get('masked.sites'))['masked.sites'] || {}; } catch { state.sites = {}; }
}
async function disconnectSite(origin) {
  const s = (await chrome.storage.local.get('masked.sites'))['masked.sites'] || {};
  delete s[origin];
  await chrome.storage.local.set({ 'masked.sites': s });
  await loadSites();
}

// ---- private trading ----
// Sites that the user allows can trade from a private trade address (see trade-core.mjs). Bitcoin and
// tokens move between Shielded and the trade address inside the wallet; the site only ever sees the
// trade address and the Shielded totals, never the Shielded address or its payments.
const TRADE_SITES = new Set(['https://maskedwallet.com', 'https://www.maskedwallet.com']);
const tradeStoreKey = () => `wren.trade.${walletId()}`;
function tradeSt() {
  const id = walletId();
  if (!state.tradeSt || state.tradeSt.id !== id) {
    let s = null; try { s = JSON.parse(localStorage.getItem(tradeStoreKey()) || 'null'); } catch {}
    state.tradeSt = { cur: 0, on: false, checked: false, pend: [], ...(s || {}), id };
  }
  return state.tradeSt;
}
function saveTradeSt() { const { id, ...s } = tradeSt(); try { localStorage.setItem(tradeStoreKey(), JSON.stringify(s)); } catch {} }
const tradeMemo = new Map();
function tradeKeyAt(n) {
  const k = `${walletId()}:${n}`;
  if (!tradeMemo.has(k)) tradeMemo.set(k, trade.tradeKey(state.wallet.bSpend, n, state.net));
  return tradeMemo.get(k);
}
const canTrade = () => canSign() && state.wallet.source !== 'example';
const tradeCur = () => tradeKeyAt(tradeSt().cur);
/** The trade key for an output script (any address used so far, plus the next one). */
function tradeKeyBySpk(spkHex) {
  if (!canTrade() || !spkHex) return null;
  for (let n = 0; n <= tradeSt().cur + 1; n++) { const k = tradeKeyAt(n); if (k.spk === spkHex) return k; }
  return null;
}
async function tradeUtxos(k = tradeCur()) {
  const list = await readJson(await fetch(`${esploraBase()}address/${k.address}/utxo`), 'Trade address lookup');
  if (!Array.isArray(list)) throw new Error('Trade address lookup returned an unexpected reply.');
  return list.map((u) => ({ key: `trade:${u.txid}:${u.vout}`, kind: 'trade', txid: u.txid, vout: u.vout, sats: u.value, output: k.outputX, privKey: k.priv, address: k.address, pending: !u.status?.confirmed }));
}
/** Tokens on a trade address, from the token server (null when it cannot answer). */
async function tradeTokens(address) {
  if (!indexerUrl()) return null;
  try {
    const list = await idxGet(`/v1/brc20/wallet_tokens?address=${address}`);
    return Array.isArray(list) ? list.filter((t) => t.ticker).map((t) => ({ ...t, ticker: String(t.ticker).toLowerCase() })) : list == null ? [] : null;
  } catch { return null; }
}
/** After a restore: find the trade address in use (addresses are only renewed once emptied). */
async function discoverTrade() {
  const s = tradeSt();
  if (s.checked || !canTrade()) return;
  let last = -1;
  for (let n = 0; n < 50; n++) {
    const a = await readJson(await fetch(`${esploraBase()}address/${tradeKeyAt(n).address}`), 'Trade address lookup');
    if ((a.chain_stats?.tx_count || 0) + (a.mempool_stats?.tx_count || 0) === 0) break;
    last = n;
  }
  if (last >= 0) {
    const k = tradeKeyAt(last);
    const coins = await tradeUtxos(k);
    const toks = coins.length ? [] : await tradeTokens(k.address);
    s.cur = coins.length || toks == null || toks.some((t) => Number(t.overall) > 0) ? last : last + 1;
  }
  s.checked = true; saveTradeSt();
}
/** Shielded token balances by ticker (what the site may show in "Trade from Shielded"). */
/** Transfers inscribed in Shielded for selling whose coin is still unspent (pending, unlisted or listed): the site lists them without inscribing again. */
function shieldedTransfersOpen() {
  return transfers().filter((t) => t.listing).map((t) => ({ t, c: state.coins.find((c) => c.key === t.listing) })).filter((x) => x.c)
    .map(({ t, c }) => ({ ticker: t.tick, amount: String(t.amt), inscriptionId: `${t.revealTxid}i0`, outpoint: t.listing, value: c.sats, address: addrOfScript(fromHex(t.fromSpk)), pending: !!c.pending, at: t.at }));
}
function shieldedTokenTotals() {
  return knownTokens().map((t) => ({ tick: t.tick, amt: tokenHoldings(t.tick).filter((h) => holderKey(h.pkscript)?.kind === 'shielded').reduce((a, h) => a + h.amt, 0) })).filter((x) => x.amt > 0);
}
function tradeInfo() {
  const k = tradeCur();
  // features: what this wallet can do for the site (2.12.5: list tokens straight from Shielded)
  return { net: UNISAT_NET[state.net], address: k.address, index: k.index, publicKey: k.outputX, features: ['shieldedListing'], shielded: { sats: sum(shieldedCoins()), tokens: shieldedTokenTotals(), transfers: shieldedTransfersOpen() } };
}
function publishTrade() {
  if (!hasExt() || !state.wallet) return;
  const s = canTrade() ? tradeSt() : null;
  if (!s?.on) { if (state._tradePub !== 'off') { state._tradePub = 'off'; chrome.storage.local.remove('masked.trade').catch(() => {}); } return; }
  const v = tradeInfo();
  const key = JSON.stringify(v);
  if (key === state._tradePub) return;
  state._tradePub = key;
  chrome.storage.local.set({ 'masked.trade': { ...v, updatedAt: Date.now() } }).catch(() => {});
}
/** Transfer inscriptions made on the trade address that the token server may not count yet. */
async function tradePending(tick) {
  const s = tradeSt();
  const keep = [];
  for (const p of s.pend || []) {
    if (Date.now() - p.at > 2 * 864e5) continue;
    if (!p.confirmedAt) { try { const r = await fetch(`${esploraBase()}tx/${p.txid}/status`); const j = r.ok ? await r.json() : null; if (j?.confirmed) p.confirmedAt = Date.now(); } catch {} }
    if (p.confirmedAt && Date.now() - p.confirmedAt > 10 * 60000) continue; // the token server has it by now
    keep.push(p);
  }
  s.pend = keep; saveTradeSt();
  return keep.filter((p) => p.tick === tick && p.address === tradeCur().address).reduce((a, p) => a + p.amt, 0);
}
const tradeCoinsFor = () => (state.tradeCoins || []).filter((c) => c.sats > INSCRIPTION_MAX && !isProtected(c) && !unverified(c));
/** Shielded coins in the shape trade-core takes. */
const shieldedForTrade = () => shieldedCoins().map((c) => ({ txid: c.txid, vout: c.vout, value: c.sats, priv: c.privKey || sp.outputPrivKey(state.wallet.bSpend, c.tweak), key: c.key }));
async function buildTradeFund({ sats, padding = false, rate }) {
  if (!canTrade()) throw new Error('This wallet cannot trade privately (watch-only or demo).');
  await ensureOrd('shielded');
  const k = tradeCur();
  sats = Number(sats) || 0;
  if (sats && sats < DUST_CHANGE) throw new Error(`The amount must be at least ${DUST_CHANGE} sats.`);
  const outputs = [...(padding ? [{ script: fromHex(k.spk), value: trade.TRADE_PADDING }] : []), ...(sats ? [{ script: fromHex(k.spk), value: sats }] : [])];
  if (!outputs.length) throw new Error('Nothing to move.');
  const coins = shieldedForTrade();
  if (!coins.length) throw new Error('Your Shielded balance is empty.');
  const b = trade.buildShieldedPay({ coins, outputs, changeAddress: address(0), feeRate: rate });
  return { ...b, address: k.address, amount: outputs.reduce((a, o) => a + o.value, 0), padding, spentKeys: b.spent.map((c) => c.key) };
}
async function buildTradeReturn({ rate }) {
  if (!canTrade()) throw new Error('This wallet cannot trade privately (watch-only or demo).');
  const k = tradeCur();
  const coins = await tradeUtxos(k);
  state.tradeCoins = coins;
  if (!coins.length) return { empty: true, address: k.address, items: 0, total: 0, fee: 0, spentKeys: [] };
  await checkOrd(coins);
  // anything small, unconfirmed or not checked by ord yet is kept on its own coin (it may hold an inscription)
  const keep = (c) => c.sats <= INSCRIPTION_MAX || c.pending || !ordOf(c) || !!(ordOf(c).ins || ordOf(c).runes);
  const list = coins.map((c) => ({ txid: c.txid, vout: c.vout, value: c.sats, priv: c.privKey, keep: keep(c), key: c.key }));
  const b = trade.buildReturnToShielded({ coins: list, extra: shieldedForTrade(), shieldAddress: shieldAddr(), feeRate: rate });
  return { ...b, address: k.address, items: list.filter((c) => c.keep).length, total: list.reduce((a, c) => a + c.value, 0), spentKeys: b.spent.map((c) => c.key).filter(Boolean) };
}
async function buildTradeTransferInscribe({ tick, amt, rate }) {
  tick = String(tick || '').trim().toLowerCase(); checkTick(tick);
  amt = checkAmount(amt, 'Amount');
  const k = tradeCur();
  const toks = await tradeTokens(k.address);
  if (toks == null) throw new Error('The token server is not answering. Try again in a minute.');
  const it = toks.find((t) => t.ticker === tick);
  const avail = Math.max(0, (Number(it?.available) || 0) - (await tradePending(tick)));
  const T = tick.toUpperCase();
  if (Number(amt) > avail) throw new Error(avail ? `Only ${avail.toLocaleString()} ${T} available on your trade address.` : `No ${T} on your trade address yet. Move some from Shielded first (it needs 1 confirmation).`);
  state.tradeCoins = await tradeUtxos(k).catch(() => []);
  // the fee comes from Shielded when it can (nothing links back), otherwise from the trade address itself
  const from = sum(shieldedCoins()) ? 'shielded' : 'trade';
  const ins = await buildInscription({ from, rate, recipient: k.address, body: jsonBody({ p: 'brc-20', op: 'transfer', tick, amt }), meta: { op: 'transfer', tick, amt }, postage: TRANSFER_POSTAGE });
  return { ...ins, op: 'transfer', tick, amt, tradeAddress: k.address, avail };
}
async function buildTradeTokenMove({ tick, amt, rate, back = false }) {
  if (!canTrade()) throw new Error('This wallet cannot trade privately (watch-only or demo).');
  const k = tradeCur();
  if (!back) return buildTokenSend({ tick, amt, to: k.address, from: 'shielded', rate, only: 'shielded' });
  tick = String(tick || '').trim().toLowerCase(); checkTick(tick);
  const toks = await tradeTokens(k.address);
  if (toks == null) throw new Error('The token server is not answering. Try again in a minute.');
  const avail = Math.max(0, (Number(toks.find((t) => t.ticker === tick)?.available) || 0) - (await tradePending(tick)));
  state.tradeCoins = await tradeUtxos(k).catch(() => []);
  return buildTokenSend({ tick, amt, to: shieldAddr(), from: sum(shieldedCoins()) ? 'shielded' : 'trade', rate, holder: { pkscript: k.spk, amt: avail, key: { priv: k.priv, kind: 'trade' } } });
}
/** Renew the trade address once nothing is left on it, so the next trades use a fresh one. */
async function maybeRenewTrade(spentAll) {
  const k = tradeCur();
  if (!spentAll) return false;
  const toks = await tradeTokens(k.address);
  if (toks == null || toks.some((t) => Number(t.overall) > 0)) return false;
  const s = tradeSt(); s.cur += 1; saveTradeSt(); publishTrade();
  return true;
}
// ---- listing straight from Shielded (2.12.5) ----
// A BRC-20 balance in Shielded sits on a silent-payment output (a one-time address only this wallet knows).
// The transfer is inscribed onto that same output script and listed from there: no move to the trade address.
// Those "holder" scripts are remembered so the wallet can sign the listing and sees the bitcoin when it sells.
function holderList() { const s = tradeSt(); return (s.holders ||= {}); }
/** Key for a taproot script this wallet controls without a taproot tweak: the trade address or a listed Shielded holder. */
function keyPathFor(spkHex) {
  if (!canTrade() || !spkHex) return null;
  const t = tradeKeyBySpk(spkHex);
  if (t) return { priv: t.priv, kind: 'trade', index: t.index };
  const h = holderList()[spkHex];
  return h ? { priv: sp.outputPrivKey(state.wallet.bSpend, h.tweak), kind: 'shielded' } : null;
}
async function buildShieldedTransferInscribe({ tick, amt, rate }) {
  if (!canTrade()) throw new Error('This wallet cannot trade privately (watch-only or demo).');
  tick = String(tick || '').trim().toLowerCase(); checkTick(tick);
  amt = checkAmount(amt, 'Amount');
  const T = tick.toUpperCase();
  const all = tokenHoldings(tick).filter((h) => holderKey(h.pkscript)?.kind === 'shielded');
  const h = all.filter((x) => x.amt >= Number(amt)).sort((a, b) => a.amt - b.amt)[0];
  if (!h) {
    const max = all.reduce((a, x) => Math.max(a, x.amt), 0);
    throw new Error(max ? `You can list up to ${max.toLocaleString()} ${T} at once from Shielded (they sit on ${all.length} coins).` : `No ${T} in Shielded.`);
  }
  const coin = state.coins.find((c) => c.output === h.pkscript.slice(4) && c.tweak);
  if (!coin) throw new Error('The coin holding these tokens is not in the wallet yet. Open MASKED and let it sync.');
  await ensureOrd('shielded');
  if (!sum(shieldedCoins())) throw new Error('Not enough Shielded bitcoin for the network fee. Add a little BTC to Shielded first.');
  const ins = await buildInscription({ from: 'shielded', rate, recipient: '', rawRecipientScript: fromHex(h.pkscript), body: jsonBody({ p: 'brc-20', op: 'transfer', tick, amt }), meta: { op: 'transfer', tick, amt }, postage: TRANSFER_POSTAGE });
  return { ...ins, op: 'transfer', tick, amt, holderSpk: h.pkscript, holderAddress: addrOfScript(fromHex(h.pkscript)), holderTweak: coin.tweak, holderLabel: coin.label ?? null, avail: h.amt, shieldedListing: true };
}
/** After broadcasting: remember the holder, add the new transfer coin, and take the amount off the Shielded balance. */
function recordShieldedListing(b) {
  const s = tradeSt();
  holderList()[b.holderSpk] = { tweak: b.holderTweak, label: b.holderLabel, address: b.holderAddress, at: Date.now() };
  saveTradeSt();
  const key = `${b.revealTxid}:${b.revealOut}`;
  if (!state.coins.some((c) => c.key === key)) state.coins.push({ key, txid: b.revealTxid, vout: b.revealOut, sats: b.estimate.revealValue, output: b.holderSpk.slice(4), tweak: b.holderTweak, label: b.holderLabel, pending: true, listed: true });
  setInsc(key, { brc20: true, op: 'transfer', tick: b.tick, amt: b.amt, id: b.inscriptionId, ready: true });
  saveTransfers([{ tick: b.tick, amt: b.amt, to: 'Listed for sale', toKind: 'listing', toSpk: '', toOwn: false, fromSpk: b.holderSpk, commitTxid: b.commitTxid, revealTxid: b.revealTxid, sendTxid: b.revealTxid, listing: key, at: Date.now() }, ...transfers()]);
  saveCoins();
}
/** Bitcoin (sales) and items (swaps) arriving at listed holders show up in Shielded. */
async function syncHolders() {
  if (!canTrade()) return;
  // every Shielded coin that holds tokens is a holder: a transfer inscribed onto its script (by any MASKED, also
  // before a reinstall or in another browser) sits there as a new coin that silent-payment scanning cannot see
  const H = holderList(); let grew = false;
  const mintSpks = new Set(mints().map((m) => m.pkscript).filter(Boolean));
  for (const c of state.coins) {
    if (!c.tweak || c.example) continue;
    const spk = toHex(p2trScript(c.output)), i = inscOf(c);
    if (H[spk] || !(mintSpks.has(spk) || (i?.brc20 && (i.op === 'mint' || (i.op === 'transfer' && i.received))))) continue;
    H[spk] = { tweak: c.tweak, label: c.label ?? null, address: addrOfScript(fromHex(spk)), at: Date.now() }; grew = true;
  }
  if (grew) saveTradeSt();
  const hs = Object.entries(H);
  if (!hs.length) return;
  let added = false;
  for (const [spk, h] of hs) {
    try {
      const list = await readJson(await fetch(`${esploraBase()}address/${h.address}/utxo`), 'Balance lookup');
      for (const u of list || []) {
        const key = `${u.txid}:${u.vout}`;
        const have = state.coins.find((c) => c.key === key);
        if (have) { if (u.status?.confirmed) have.pending = false; continue; }
        state.coins.push({ key, txid: u.txid, vout: u.vout, sats: u.value, output: spk.slice(4), tweak: h.tweak, label: h.label ?? null, pending: !u.status?.confirmed });
        added = true;
      }
    } catch {}
  }
  if (added) saveCoins();
}
/** A transfer inscription found on a Shielded holder with no record (inscribed elsewhere, or before a reinstall): it is
 *  ready to sell, so record it like one inscribed here (taken off the free balance, shown and reported to the site). */
function recoverShieldedTransfers() {
  if (!canTrade()) return;
  const H = holderList(), recs = transfers(), add = [];
  for (const c of state.coins) {
    const spk = toHex(p2trScript(c.output)), i = inscOf(c);
    if (!H[spk] || !i?.brc20 || i.op !== 'transfer' || i.received || !i.tick) continue;
    if (recs.some((t) => t.listing === c.key || t.revealTxid === c.txid)) continue;
    add.push({ tick: i.tick, amt: i.amt, to: 'Listed for sale', toKind: 'listing', toSpk: '', toOwn: false, fromSpk: spk, commitTxid: '', revealTxid: c.txid, sendTxid: c.txid, listing: c.key, at: i.at || Date.now(), recovered: true });
    c.listed = true;
  }
  if (add.length) { saveTransfers([...add, ...recs]); saveCoins(); }
}
/** Cancel a listing made from Shielded: move the listed coin back into Shielded (the signed listing dies everywhere). */
async function buildShieldedCancel({ outpoint, rate }) {
  if (!canTrade()) throw new Error('This wallet cannot trade privately (watch-only or demo).');
  const c = state.coins.find((x) => x.key === outpoint);
  const spk = c ? toHex(p2trScript(c.output)) : '';
  if (!c || !holderList()[spk]) throw new Error('That listing is not one of this wallet\'s Shielded listings.');
  await ensureOrd('shielded');
  const i = inscOf(c) || {};
  const extra = shieldedForTrade().filter((x) => x.key !== c.key && !(x.txid === c.txid && x.vout === c.vout));
  const b = trade.buildReturnToShielded({ coins: [{ txid: c.txid, vout: c.vout, value: c.sats, priv: sp.outputPrivKey(state.wallet.bSpend, c.tweak), keep: true, key: c.key }], extra, shieldAddress: shieldAddr(), feeRate: rate });
  return { ...b, coin: c, tick: i.tick, amt: i.amt, spentKeys: b.spent.map((x) => x.key).filter(Boolean) };
}
function tradeSection() {
  if (!canTrade() || !tradeSt().on) return '';
  const k = tradeCur();
  return `<section class="card menu">
    <div class="menu-row"><span>${I.shieldPlain}<b>Private trading</b></span><span class="muted small">On</span></div>
    <p class="muted small pad">Sites you allowed trade from this private address. It is made from your recovery phrase, not linked to your Public or Shielded address, and renewed each time you move everything back to Shielded.</p>
    <div class="kv small">${rowKV('Trade address', `<a class="mono" href="${esc(mempoolAddressUrl(k.address))}" target="_blank" rel="noopener">${esc(short(k.address, 8))}</a>`)}${rowKV('Number', `#${k.index + 1}`)}</div>
  </section>`;
}

// ---- message signing ----
const accountPriv = () => normalizeSchnorrPriv(state.wallet.fundingPriv); // internal key (even Y), pubkey = 02||internalX
function signMessageEcdsa(message) {
  const m = enc.encode(message);
  const magic = enc.encode('\x18Bitcoin Signed Message:\n');
  const h = sha256(sha256(concat(magic, varint(m.length), m)));
  const sig = secp256k1.sign(h, accountPriv(), { lowS: true });
  const out = concat(u8(27 + sig.recovery + 4), sig.toCompactRawBytes());
  return btoa(String.fromCharCode(...out));
}
/** BIP-322 "simple" signature for the Public (P2TR) address. */
function signMessageBip322(message) {
  const f = fundingInfo();
  const spk = p2trScript(f.outputX);
  const msgHash = sp.taggedHash('BIP0322-signed-message', enc.encode(message));
  const toSpend = concat(u32le(0), u8(1), ZERO32, u32le(0xffffffff), u8(34), u8(0x00), u8(0x20), msgHash, u32le(0),
    u8(1), u64le(0), varint(spk.length), spk, u32le(0));
  const toSpendId = toHex(rev(sha256(sha256(toSpend))));
  const tx = new btc.Transaction({ version: 0, allowUnknownOutputs: true });
  tx.addInput({ txid: toSpendId, index: 0, sequence: 0, witnessUtxo: { script: spk, amount: 0n }, tapInternalKey: fromHex(f.internalX) });
  tx.addOutput({ script: u8(0x6a), amount: 0n });
  tx.signIdx(accountPriv(), 0);
  tx.finalizeIdx(0);
  const w = tx.getInput(0).finalScriptWitness;
  const ser = concat(varint(w.length), ...w.map((x) => concat(varint(x.length), x)));
  return btoa(String.fromCharCode(...ser));
}

// ---- PSBT ----
function addrOfScript(script) {
  try { return btc.Address(btcNet()).encode(btc.OutScript.decode(script)); } catch { return null; }
}
/** Read a PSBT and work out what it does to this wallet. */
function analysePsbt(psbtHex, options = {}) {
  const tx = btc.Transaction.fromPSBT(fromHex(psbtHex), { allowUnknownOutputs: true, allowUnknownInputs: true });
  const f = fundingInfo();
  const ourSpk = toHex(p2trScript(f.outputX));
  const want = Array.isArray(options.toSignInputs) && options.toSignInputs.length ? options.toSignInputs : null;
  const inputs = [], outputs = [];
  let spent = 0, received = 0;
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    const txid = inp.txid ? toHex(inp.txid) : '';
    const value = inp.witnessUtxo ? Number(inp.witnessUtxo.amount) : null;
    const spk = inp.witnessUtxo ? toHex(inp.witnessUtxo.script) : null;
    const tk = spk && spk !== ourSpk ? keyPathFor(spk) : null; // the private trade address, or a listed Shielded holder
    const ours = spk === ourSpk || !!tk;
    const w = want?.find((x) => x.index === i);
    const sign = want ? !!w : ours;
    if (w && !ours) throw new Error(`Input ${i} does not belong to this wallet's Public or trade address.`);
    if (w?.disableTweakSigner) throw new Error('Script-path signing (disableTweakSigner) is not supported yet.');
    const coin = tk ? null : state.fundingCoins.find((c) => c.txid === txid && c.vout === inp.index);
    const tcoin = tk ? (state.tradeCoins || []).find((c) => c.txid === txid && c.vout === inp.index) : null;
    const prot = ours && ((coin && (isProtected(coin) || unverified(coin))) || (tcoin && (isProtected(tcoin) || unverified(tcoin))) || (value != null && value <= INSCRIPTION_MAX));
    const sighash = w?.sighashTypes?.length ? w.sighashTypes : inp.sighashType != null ? [inp.sighashType] : null;
    if (ours) spent += value || 0;
    inputs.push({ i, txid, vout: inp.index, value, address: spk ? addrOfScript(fromHex(spk)) : null, ours, keyed: tk ? tk.kind : null, spk, trade: tk?.kind === 'trade' ? tk.index : null, sign, prot, sighash, finalized: !!inp.finalScriptWitness });
  }
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    const tk = keyPathFor(toHex(o.script));
    const ours = toHex(o.script) === ourSpk || !!tk;
    if (ours) received += Number(o.amount);
    outputs.push({ i, value: Number(o.amount), address: addrOfScript(o.script) || (o.script[0] === 0x6a ? 'OP_RETURN' : 'unknown'), ours, keyed: tk ? tk.kind : null, trade: tk?.kind === 'trade' ? tk.index : null });
  }
  const toSign = inputs.filter((x) => x.sign);
  return { tx, inputs, outputs, toSign, net: received - spent, protectedCount: toSign.filter((x) => x.prot).length, trade: toSign.some((x) => x.keyed) };
}
function signPsbtHex(psbtHex, options = {}) {
  const a = analysePsbt(psbtHex, options);
  if (!a.toSign.length) throw new Error('Nothing in this PSBT for this wallet to sign.');
  const internal = fromHex(fundingInfo().internalX);
  // trade address inputs: the output key is the key itself (no taproot tweak)
  const tr = a.toSign.filter((x) => x.keyed);
  if (tr.length) trade.signKeyPathInputs(a.tx, tr.map((x) => ({ i: x.i, priv: keyPathFor(x.spk).priv, sighash: x.sighash?.[0] })), { finalize: options.autoFinalized !== false });
  for (const x of a.toSign) {
    if (x.keyed) continue;
    if (!a.tx.getInput(x.i).tapInternalKey) a.tx.updateInput(x.i, { tapInternalKey: internal });
    a.tx.signIdx(accountPriv(), x.i, x.sighash || undefined);
    if (options.autoFinalized !== false) a.tx.finalizeIdx(x.i);
  }
  return toHex(a.tx.toPSBT());
}

// ---- approval window ----
const reqId = new URLSearchParams(location.search).get('req');
async function loadApproval() {
  state.view = 'approve';
  state.approval = { id: reqId, loading: true };
  render();
  // closing this popup (clicking away) tells the background to reject the request
  try { if (!state.apPort) state.apPort = chrome.runtime.connect({ name: `approval:${reqId}` }); } catch {}
  try {
    const r = await chrome.runtime.sendMessage({ type: 'getRequest', id: reqId });
    if (!r) { state.approval = { id: reqId, gone: true }; render(); return; }
    state.approval = { id: reqId, ...r, loading: false };
  } catch { state.approval = { id: reqId, gone: true }; }
  prepApproval();
}
/** Build whatever the screen needs (fees, PSBT breakdown). Re-run after each sync. */
function prepApproval() {
  const a = state.approval;
  if (!a || a.loading || a.gone || a.done) return render();
  try {
    if (a.method === 'sendBitcoin') {
      if (!state.fundingCoins.length && state.syncing) { a.prep = null; return render(); }
      a.prepErr = null;
      const rate = Number(a.params.options?.feeRate) || feeRate();
      buildSend({ from: 'public', to: a.params.toAddress, amount: Number(a.params.satoshis), rate })
        .then((b) => { a.prep = b; render(); })
        .catch((e) => { a.prepErr = friendly(e.message); render(); });
    }
    // private trading: built once (they read the network); rebuilt after a sync if they failed
    const once = (fn) => {
      if (a.prep || a.prepBusy || (a.prepErr && (state.syncing || a.errGen === state.syncGen))) return;
      a.prepBusy = true; a.prepErr = null;
      fn().then((b) => { a.prep = b; }).catch((e) => { a.prepErr = friendly(e.message); a.errGen = state.syncGen; }).finally(() => { a.prepBusy = false; render(); });
    };
    const P = a.params || {}, trading = a.method === 'inscribeTransfer' && (P.options?.account === 'trade' || P.options?.account === 'shielded');
    if (a.method === 'shareTrade') once(async () => { if (!canTrade()) throw new Error('Private trading needs a wallet with its recovery phrase or spend key (not watch-only or demo).'); await discoverTrade(); return tradeInfo(); });
    if (a.method === 'fundTrade') once(() => buildTradeFund({ sats: Number(P.satoshis) || 0, padding: !!P.padding, rate: Number(P.feeRate) || feeRate() }));
    if (a.method === 'moveToTrade') once(() => buildTradeTokenMove({ tick: P.ticker, amt: P.amount, rate: feeRate() }));
    if (a.method === 'returnToShielded') once(() => (P.ticker ? buildTradeTokenMove({ tick: P.ticker, amt: P.amount, rate: feeRate(), back: true }) : buildTradeReturn({ rate: feeRate() })));
    if (trading) once(() => (P.options.account === 'shielded' ? buildShieldedTransferInscribe : buildTradeTransferInscribe)({ tick: P.ticker, amt: P.amount, rate: feeRate() }));
    if (a.method === 'cancelShielded') once(() => buildShieldedCancel({ outpoint: String(P.outpoint || ''), rate: feeRate() }));
    if ((a.method === 'signPsbt' || a.method === 'signPsbts') && !a.tradeLoaded && canTrade() && tradeSt().on) {
      a.tradeLoaded = true;
      tradeUtxos().then((c) => { state.tradeCoins = c; return checkOrd(c); }).catch(() => {}).finally(prepApproval);
    }
    if (a.method === 'inscribeTransfer' && !trading) {
      a.prepErr = null;
      const go = () => buildTransferInscribe({ tick: a.params.ticker, amt: a.params.amount, from: 'public', rate: feeRate() })
        .then((b) => { a.prep = b; render(); }).catch((e) => { a.prepErr = friendly(e.message); render(); });
      if (!a.idxAsked && !idxTok(String(a.params.ticker).toLowerCase())) { a.idxAsked = true; refreshIdxWallet().then(go); } else go();
    }
    if ((a.method === 'signPsbt' || a.method === 'signPsbts') && !a.ordChecked) { a.ordChecked = true; checkOrd(state.fundingCoins).then(prepApproval); }
    if (a.method === 'signPsbt') a.prep = [analysePsbt(a.params.psbtHex, a.params.options || {})];
    if (a.method === 'signPsbts') a.prep = a.params.psbtHexs.map((h, k) => analysePsbt(h, (a.params.options || [])[k] || {}));
    // the trade address and Shielded listings sign for MASKED's own website only
    if ((a.method === 'signPsbt' || a.method === 'signPsbts') && a.prep.some((p) => p.trade) && !TRADE_SITES.has(a.origin)) { a.prep = null; throw new Error('Only maskedwallet.com can ask MASKED to sign for your trade address or Shielded listings.'); }
  } catch (e) { a.prepErr = friendly(e.message); }
  render();
}
function finishApproval(payload) {
  const a = state.approval;
  a.done = true;
  render();
  chrome.runtime.sendMessage({ type: 'resolveRequest', id: a.id, ...payload }).finally(() => setTimeout(() => window.close(), 150));
}
async function approveRequest() {
  const a = state.approval;
  state.busy = true; render();
  try {
    let result;
    switch (a.method) {
      case 'requestAccounts': result = [pubAddr()]; break;
      case 'signMessage': result = a.params.type === 'bip322-simple' ? signMessageBip322(a.params.message) : signMessageEcdsa(a.params.message); break;
      case 'signPsbt': {
        if (a.prep[0].protectedCount && !state.f.apRisk) throw new Error('Tick the box to confirm spending an inscription coin.');
        result = signPsbtHex(a.params.psbtHex, a.params.options || {}); break;
      }
      case 'signPsbts': {
        if (a.prep.some((p) => p.protectedCount) && !state.f.apRisk) throw new Error('Tick the box to confirm spending an inscription coin.');
        result = a.params.psbtHexs.map((h, k) => signPsbtHex(h, (a.params.options || [])[k] || {})); break;
      }
      case 'sendBitcoin': {
        const b = a.prep;
        if (!b) throw new Error(a.prepErr || 'Still preparing the transaction.');
        await broadcastHex(DEFAULT_BROADCAST[state.net], b.hex);
        afterBroadcast([b.coin.key], [b.txid]);
        result = b.txid; break;
      }
      case 'shareTrade': {
        if (!a.prep) throw new Error(a.prepErr || 'Still preparing.');
        const s = tradeSt(); s.on = true; saveTradeSt(); state._tradePub = null; publishTrade();
        result = tradeInfo(); break;
      }
      case 'fundTrade': {
        const b = a.prep;
        if (!b) throw new Error(a.prepErr || 'Still preparing the transaction.');
        await broadcastHex(DEFAULT_BROADCAST[state.net], b.hex);
        afterBroadcast(b.spentKeys, [b.txid]);
        result = { txid: b.txid, address: b.address, outputs: b.outputs }; break;
      }
      case 'moveToTrade': case 'returnToShielded': {
        const b = a.prep;
        if (!b) throw new Error(a.prepErr || 'Still preparing the transaction.');
        const url = DEFAULT_BROADCAST[state.net];
        if (b.op === 'tsend') {
          await broadcastHex(url, b.commitHex); await broadcastHex(url, b.revealHex); await broadcastHex(url, b.sendHex);
          saveTransfers([{ tick: b.tick, amt: b.amt, to: b.to, toKind: b.toKind, toSpk: b.toSpk, toOwn: b.toOwn, fromSpk: b.fromSpk, commitTxid: b.commitTxid, revealTxid: b.revealTxid, sendTxid: b.sendTxid, at: Date.now() }, ...transfers()]);
          setInsc(`${b.sendTxid}:0`, { brc20: true, op: 'transfer', tick: b.tick, amt: b.amt, id: b.inscriptionId });
          if (b.fromKind === 'trade') { const s = tradeSt(); s.pend = [...(s.pend || []), { tick: b.tick, amt: Number(b.amt), txid: b.revealTxid, address: tradeCur().address, at: Date.now() }]; saveTradeSt(); }
          afterBroadcast(b.spent, [b.commitTxid, b.revealTxid, b.sendTxid]);
          result = { txid: b.sendTxid, inscriptionId: b.inscriptionId, ticker: b.tick, amount: b.amt, address: tradeCur().address }; break;
        }
        if (!b.empty) { await broadcastHex(url, b.hex); afterBroadcast(b.spentKeys, [b.txid]); }
        const renewed = await maybeRenewTrade(true).catch(() => false);
        result = { txid: b.txid || null, address: tradeCur().address, renewed }; break;
      }
      case 'inscribeTransfer': {
        const b = a.prep;
        if (!b) throw new Error(a.prepErr || 'Still preparing the inscription.');
        await broadcastHex(DEFAULT_BROADCAST[state.net], b.commitHex);
        await broadcastHex(DEFAULT_BROADCAST[state.net], b.revealHex);
        setInsc(`${b.revealTxid}:${b.revealOut}`, { brc20: true, op: 'transfer', tick: b.tick, amt: b.amt, id: b.inscriptionId, ready: true });
        if (b.shieldedListing) recordShieldedListing(b);
        else if (b.tradeAddress) { const s = tradeSt(); s.pend = [...(s.pend || []), { tick: b.tick, amt: Number(b.amt), txid: b.revealTxid, address: b.tradeAddress, at: Date.now() }]; saveTradeSt(); }
        else addPending('transfer', b.tick, b.amt, b.revealTxid);
        afterBroadcast(b.spent, [b.commitTxid, b.revealTxid]);
        result = { inscriptionId: b.inscriptionId, txid: b.revealTxid, commitTxid: b.commitTxid, ticker: b.tick, amount: b.amt, ...(b.shieldedListing ? { address: b.holderAddress, outpoint: `${b.revealTxid}:${b.revealOut}`, value: b.estimate.revealValue } : {}) }; break;
      }
      case 'cancelShielded': {
        const b = a.prep;
        if (!b) throw new Error(a.prepErr || 'Still preparing the transaction.');
        await broadcastHex(DEFAULT_BROADCAST[state.net], b.hex);
        // the transfer inscription comes back to a new Shielded coin, and the tokens with it
        saveTransfers(transfers().filter((t) => t.listing !== b.coin.key));
        if (b.tick) setInsc(`${b.txid}:0`, { brc20: true, op: 'transfer', tick: b.tick, amt: b.amt, received: true });
        afterBroadcast(b.spentKeys, [b.txid]);
        result = { txid: b.txid }; break;
      }
      case 'switchNetwork': setNet(a.params.target); result = UNISAT_NET[a.params.target]; break;
      default: throw new Error('Unsupported request.');
    }
    finishApproval({ result });
  } catch (e) {
    state.status.approve = [friendly(e.message), 'err'];
  } finally { state.busy = false; render(); }
}
function rejectRequest() { finishApproval({ error: { code: 4001, message: 'User rejected the request.' } }); }

function psbtCard(p, k, total) {
  const row = (x, kind) => `<div class="pz-row ${x.ours ? 'mine' : ''} ${x.prot && x.sign ? 'danger' : ''}">
      <span class="pz-i">${kind}${x.i}</span>
      <span class="pz-a"><span class="mono">${esc(x.address ? short(x.address, 8) : x.txid ? short(x.txid, 6) + ':' + x.vout : '?')}</span>
        ${x.ours ? `<span class="badge v2">${x.keyed === 'trade' ? 'Your trade address' : x.keyed === 'shielded' ? 'Your Shielded listing' : 'You'}</span>` : ''}${x.sign ? '<span class="badge">sign</span>' : ''}${x.prot && x.sign ? `<span class="badge red">${I.lock} inscription</span>` : ''}${x.sighash ? `<span class="badge">sighash ${x.sighash.join(',')}</span>` : ''}</span>
      <span class="pz-v">${x.value != null ? fmtBtc(x.value) : '?'}</span></div>`;
  return `<div class="pz">
    ${total > 1 ? `<p class="card-title">PSBT ${k + 1} of ${total}</p>` : ''}
    <p class="lbl">Inputs</p>${p.inputs.map((x) => row(x, 'in ')).join('')}
    <p class="lbl">Outputs</p>${p.outputs.map((x) => row(x, 'out ')).join('')}
    <div class="kv">${rowKV('Your balance change', `<b class="${p.net < 0 ? 'neg' : 'good'}">${p.net > 0 ? '+' : ''}${fmtBtc(p.net)} ${unit()}</b>`)}${rowKV('Inputs you sign', `${p.toSign.length}`)}</div>
  </div>`;
}
function viewApprove() {
  const a = state.approval;
  if (!a || a.loading) return `<section class="card center"><p class="muted">Loading request…</p></section>`;
  if (a.gone) return `<section class="card center"><p>This request has expired.</p><button class="btn ghost" onclick="window.close()">Close</button></section>`;
  if (a.done) return `<section class="done"><div class="done-ic">${I.check}</div><h1>Done</h1><p class="muted">You can close this window.</p></section>`;
  let host = a.origin; try { host = new URL(a.origin).host; } catch {}
  const titles = { requestAccounts: 'Connect to MASKED', signMessage: 'Sign message', signPsbt: 'Sign transaction', signPsbts: 'Sign transactions', sendBitcoin: 'Send bitcoin', switchNetwork: 'Switch network', inscribeTransfer: 'Inscribe transfer', shareTrade: 'Trade from Shielded', fundTrade: 'Move BTC to trading', moveToTrade: 'Move tokens to trading', returnToShielded: 'Move back to Shielded', cancelShielded: 'Cancel listing' };
  let body = '';
  const P = a.params || {};
  switch (a.method) {
    case 'requestAccounts':
      body = `<div class="kv">${rowKV('Address it will see', `${btcLogo}<span class="mono">${esc(short(pubAddr(), 8))}</span>`)}${rowKV('Network', esc(net().name))}</div>
        <ul class="perm"><li>${I.check} See your Public address and balance</li><li>${I.check} Ask you to approve signatures and payments</li><li class="no">${I.lock} It cannot see your Shielded coins or move funds without asking</li></ul>`;
      break;
    case 'signMessage':
      body = `<p class="lbl">Message</p><pre class="msgbox">${esc(P.message)}</pre><div class="kv">${rowKV('Signature type', P.type === 'bip322-simple' ? 'BIP-322 (address)' : 'ECDSA (public key)')}${rowKV('Signing with', `<span class="mono">${esc(short(pubAddr(), 8))}</span>`)}</div><p class="info">Signing a message is free and does not move funds.</p>`;
      break;
    case 'sendBitcoin': {
      const k = addrKind(P.toAddress);
      body = `<p class="hero-bal center">${fmtBtc(Number(P.satoshis))} <small>${unit()}</small></p>
        <div class="kv">${rowKV('To', `<span class="mono">${esc(short(P.toAddress || '', 10))}</span>`)}${rowKV('Address type', `<span class="addr-kind k-${k.kind}">${esc(k.text || '')}</span>`)}${rowKV('From', `${btcLogo}Public`)}
        ${a.prep ? rowKV('Network fee', `${fmtBtc(a.prep.fee)} ${unit()}`) + rowKV('Total', `<b>${fmtBtc(a.prep.amount + a.prep.fee)} ${unit()}</b>`) : rowKV('Network fee', a.prepErr ? '—' : 'calculating…')}</div>
        ${a.prepErr ? `<p class="msg err">${esc(a.prepErr)}</p>` : ''}`;
      break;
    }
    case 'signPsbt': case 'signPsbts': {
      if (a.prepErr) { body = `<p class="msg err">${esc(a.prepErr)}</p>`; break; }
      const risky = (a.prep || []).some((p) => p.protectedCount);
      body = (a.prep || []).map((p, k) => psbtCard(p, k, a.prep.length)).join('') + (risky ? `<label class="risk"><input type="checkbox" data-risk ${state.f.apRisk ? 'checked' : ''}><span><b>This spends an inscription coin.</b> Only continue if you mean to sell or move that inscription (e.g. a marketplace listing).</span></label>` : '');
      break;
    }
    case 'shareTrade': {
      const t = a.prep;
      body = `<div class="kv">${rowKV('Trade address it will see', t ? `<span class="mono">${esc(short(t.address, 8))}</span>` : a.prepErr ? '—' : 'finding it…')}${t ? rowKV('Shielded totals it will see', `${fmtBtc(t.shielded.sats)} ${unit()}${t.shielded.tokens.length ? ` · ${t.shielded.tokens.length} token${t.shielded.tokens.length > 1 ? 's' : ''}` : ''}`) : ''}</div>
        <ul class="perm"><li>${I.check} Buy, sell and swap from a private trade address</li><li>${I.check} Ask you to move bitcoin or tokens between Shielded and that address</li><li class="no">${I.lock} It never sees your Shielded address or its payments, and nothing moves without asking</li></ul>
        <p class="info">The trade address is made from your recovery phrase and is not linked to your Public address. Move everything back to Shielded when you are done and the next trades get a fresh one.</p>
        ${a.prepErr ? `<p class="msg err">${esc(a.prepErr)}</p>` : ''}`;
      break;
    }
    case 'fundTrade': {
      const b = a.prep;
      body = `<p class="hero-bal center">${fmtBtc(b ? b.amount : (Number(P.satoshis) || 0) + (P.padding ? trade.TRADE_PADDING : 0))} <small>${unit()}</small></p>
        <div class="kv">${rowKV('From', `${I.shieldPlain} Shielded`)}${rowKV('To', b ? `Your trade address <span class="mono">${esc(short(b.address, 6))}</span>` : 'Your trade address')}${P.padding ? rowKV('Includes', `a ${trade.TRADE_PADDING}-sat coin to hold what you buy`) : ''}
        ${b ? rowKV('Network fee', `${fmtBtc(b.fee)} ${unit()}`) + rowKV('Total', `<b>${fmtBtc(b.amount + b.fee)} ${unit()}</b>`) : rowKV('Network fee', a.prepErr ? '—' : 'calculating…')}</div>
        <p class="info">Change goes back to Shielded. The site can use these coins right away, before they confirm.</p>
        ${a.prepErr ? `<p class="msg err">${esc(a.prepErr)}</p>` : ''}`;
      break;
    }
    case 'cancelShielded': {
      const b = a.prep;
      body = `<p class="hero-bal center">${b?.tick ? `${esc(Number(b.amt).toLocaleString())} <small>${esc(String(b.tick).toUpperCase())}</small>` : 'Listing'}</p>
        <div class="kv">${rowKV('Back to', `${I.shieldPlain} Shielded`)}${b ? rowKV('Network fee', `${fmtBtc(b.fee)} ${unit()}`) : rowKV('Network fee', a.prepErr ? '—' : 'calculating…')}</div>
        <p class="info">The listed coin moves to a new Shielded coin, so the signed listing stops working everywhere. The tokens stay yours.</p>
        ${a.prepErr ? `<p class="msg err">${esc(a.prepErr)}</p>` : ''}`;
      break;
    }
    case 'moveToTrade': case 'returnToShielded': {
      const b = a.prep, back = a.method === 'returnToShielded';
      const fees = b ? (b.op === 'tsend' ? rowKV('Network fees', `${fmtBtc(b.sendTotalFee)} ${unit()} (3 small transactions)`) : rowKV('Network fee', `${fmtBtc(b.fee)} ${unit()}`)) : rowKV('Network fee', a.prepErr ? '—' : 'calculating…');
      body = P.ticker ? `<p class="hero-bal center">${esc(Number(P.amount).toLocaleString())} <small>${esc(String(P.ticker).toUpperCase())}</small></p>`
        : `<p class="hero-bal center">${b ? (b.empty ? 'Nothing left' : `${fmtBtc(b.value)} <small>${unit()}</small>`) : '…'}</p>`;
      body += `<div class="kv">${rowKV('From', back ? 'Your trade address' : `${I.shieldPlain} Shielded`)}${rowKV('To', back ? `${I.shieldPlain} Shielded` : 'Your trade address')}
        ${!P.ticker && b?.items ? rowKV('Items', `${b.items} coin${b.items > 1 ? 's' : ''} with inscriptions, each kept on its own coin`) : ''}${b?.empty ? '' : fees}</div>
        <p class="info">${P.ticker ? 'Tokens move with a transfer inscription. They count once it confirms (about 10 minutes).' : b?.empty ? 'Your trade address is empty. Approve to start using a fresh one.' : 'Everything arrives as private Shielded payments. Open orders using these coins end. Tokens on the trade address stay there: move them separately.'}</p>
        ${a.prepErr ? `<p class="msg err">${esc(a.prepErr)}</p>` : ''}`;
      break;
    }
    case 'inscribeTransfer': {
      const b = a.prep;
      if (P.options?.account === 'shielded') {
        body = `<p class="hero-bal center">${esc(Number(P.amount).toLocaleString())} <small>${esc(String(P.ticker).toUpperCase())}</small></p>
          <div class="kv">${rowKV('Inscribed on', `${I.shieldPlain} Your Shielded coin`)}${b ? rowKV('That coin holds', `${b.avail.toLocaleString()} ${esc(String(P.ticker).toUpperCase())}`) : ''}${rowKV('Fee paid from', `${I.shieldPlain} Shielded`)}
          ${b ? rowKV('Network fee', `${fmtBtc(b.estimate.totalFee)} ${unit()}`) + rowKV('Total', `<b>${fmtBtc(b.estimate.totalFee + b.estimate.revealValue)} ${unit()}</b>`) : rowKV('Network fee', a.prepErr ? '—' : 'calculating…')}</div>
          <p class="info">The tokens stay in Shielded and are listed from their own one-time address. Nothing links the listing to your Public or Shielded address. The bitcoin from the sale comes back to Shielded.</p>
          ${a.prepErr ? `<p class="msg err">${esc(a.prepErr)}</p>` : ''}`;
        break;
      }
      if (P.options?.account === 'trade') {
        body = `<p class="hero-bal center">${esc(Number(P.amount).toLocaleString())} <small>${esc(String(P.ticker).toUpperCase())}</small></p>
          <div class="kv">${rowKV('Inscribed to', 'Your trade address')}${b ? rowKV('Available there', b.avail.toLocaleString()) : ''}${b ? rowKV('Fee paid from', b.from === 'shielded' ? `${I.shieldPlain} Shielded` : 'Trade address') : ''}
          ${b ? rowKV('Network fee', `${fmtBtc(b.estimate.totalFee)} ${unit()}`) + rowKV('Total', `<b>${fmtBtc(b.estimate.totalFee + b.estimate.revealValue)} ${unit()}</b>`) : rowKV('Network fee', a.prepErr ? '—' : 'calculating…')}</div>
          <p class="info">This creates one transfer inscription the site can list or swap. The tokens stay yours until it sells.</p>
          ${a.prepErr ? `<p class="msg err">${esc(a.prepErr)}</p>` : ''}`;
        break;
      }
      body = `<p class="hero-bal center">${esc(Number(P.amount).toLocaleString())} <small>${esc(String(P.ticker).toUpperCase())}</small></p>
        <div class="kv">${rowKV('Inscribed to', `${btcLogo}Your Public address`)}${rowKV('Available now', `${transferAvail(String(P.ticker).toLowerCase()).toLocaleString()}`)}
        ${b ? rowKV('Network fee', `${fmtBtc(b.estimate.totalFee)} ${unit()}`) + rowKV('Total', `<b>${fmtBtc(b.estimate.totalFee + b.estimate.revealValue)} ${unit()}</b>`) : rowKV('Network fee', a.prepErr ? '—' : 'calculating…')}</div>
        <p class="info">This creates one transfer inscription the site can then list or send. Your tokens stay in your wallet until it is sold or sent.</p>
        ${a.prepErr ? `<p class="msg err">${esc(a.prepErr)}</p>` : ''}`;
      break;
    }
    case 'switchNetwork':
      body = `<div class="kv">${rowKV('From', esc(net().name))}${rowKV('To', `<b>${esc(NETS[P.target]?.name || P.target)}</b>`)}</div>`;
      break;
  }
  const blocked = (['sendBitcoin', 'inscribeTransfer', 'shareTrade', 'fundTrade', 'moveToTrade', 'returnToShielded', 'cancelShielded'].includes(a.method) && !a.prep) || ((a.method === 'signPsbt' || a.method === 'signPsbts') && !!a.prepErr);
  const verb = { requestAccounts: 'Connect', sendBitcoin: 'Send', inscribeTransfer: 'Inscribe', switchNetwork: 'Switch', shareTrade: 'Allow', fundTrade: 'Move', moveToTrade: 'Move', returnToShielded: 'Move back', cancelShielded: 'Cancel listing' }[a.method] || 'Sign';
  return `
    <div class="ap-site"><span class="ap-ic">${esc(host.slice(0, 1).toUpperCase())}</span><span><b>${esc(host)}</b><small>${esc(a.origin)}</small></span></div>
    <h1 class="ap-title">${titles[a.method] || a.method}</h1>
    ${isTest() ? netBanner() : ''}
    <section class="card">${body}${statusLine('approve')}</section>
    <div class="ap-actions"><button class="btn ghost" data-reject>Reject</button><button class="btn primary" data-approve ${blocked || state.busy ? 'disabled' : ''}>${state.busy ? 'Working…' : verb}</button></div>`;
}
function sitesSection() {
  if (!hasExt()) return '';
  const list = Object.entries(state.sites || {});
  return `<section class="card menu">
    <div class="menu-row"><span>${I.globe}<b>Connected sites</b></span><span class="muted small">${list.length}</span></div>
    ${list.length ? list.map(([o, v]) => `<div class="site-row"><span class="mono small">${esc(o)}</span><button class="btn ghost sm" data-unsite="${esc(o)}">Disconnect</button></div>`).join('') : '<p class="muted small pad">No sites connected. dApps use <span class="mono">window.masked</span> to ask.</p>'}
  </section>`;
}


// =====================================================================
// Vault: password-encrypted recovery phrase + auto-lock
//   disk:    localStorage['wren.vault'] = { v, kdf, iter, salt, iv, ct }  (AES-256-GCM, PBKDF2-SHA256)
//   session: chrome.storage.session['masked.session'] (RAM only, cleared on browser exit) while unlocked
// =====================================================================
const VAULT_KEY = 'wren.vault';
const LEGACY_KEY = 'wren.localWallet';
const PBKDF2_ITER = 600000;
const b64 = (u) => btoa(String.fromCharCode(...u));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const readVault = () => { try { return JSON.parse(localStorage.getItem(VAULT_KEY) || 'null'); } catch { return null; } };
const readLegacy = () => { try { const s = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null'); return s?.words ? s : null; } catch { return null; } };
const autoLockMins = () => { const v = Number(localStorage.getItem('wren.autolock')); return Number.isFinite(v) && v > 0 ? v : 15; };
const hasSession = () => typeof chrome !== 'undefined' && !!chrome.storage?.session;

async function deriveKey(password, salt, iter = PBKDF2_ITER) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function sealVault(secret, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(secret))));
  localStorage.setItem(VAULT_KEY, JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iter: PBKDF2_ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
  localStorage.removeItem(LEGACY_KEY); // never keep a plaintext copy
}
async function openVault(password) {
  const v = readVault();
  if (!v) throw new Error('No wallet found.');
  const key = await deriveKey(password, unb64(v.salt), v.iter);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) }, key, unb64(v.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch { throw new Error('Wrong password.'); }
}
function checkNewPassword(p1, p2) {
  if (String(p1 || '').length < 8) throw new Error('Use at least 8 characters for your password.');
  if (p1 !== p2) throw new Error('The two passwords do not match.');
}

// session (keeps you unlocked between popup opens until auto-lock)
async function sessionGet() { if (!hasSession()) return null; try { return (await chrome.storage.session.get('masked.session'))['masked.session'] || null; } catch { return null; } }
async function sessionSet(secret) { if (!hasSession()) return; try { await chrome.storage.session.set({ 'masked.session': { ...secret, expires: Date.now() + autoLockMins() * 60000 } }); } catch {} }
async function sessionClear() { if (!hasSession()) return; try { await chrome.storage.session.remove('masked.session'); } catch {} }

/** Load a decrypted secret into memory as the active wallet. */
function useSecret(secret) {
  try { const n = localStorage.getItem('wren.net'); if (NETS[n]) state.net = n; } catch {}
  if (!localStorage.getItem('wren.net') && secret.net && NETS[secret.net]) state.net = secret.net;
  try { if (!NETS[localStorage.getItem('wren.net')]) localStorage.setItem('wren.net', state.net); } catch {} // the lock screen and restore use it
  state.wallet = walletFromMnemonic(secret.words, secret.passphrase || '');
  state.wallet.fresh = !!secret.fresh;
  state.wallet.birthday = secret.birthday || null;
  state.wallet.restored = !!secret.restored;
  state.secret = { words: secret.words, passphrase: secret.passphrase || '', fresh: !!secret.fresh, restored: !!secret.restored, birthday: secret.birthday || null };
  loadScanProgress(); loadCoins();
}
let walletStarted = false;
function startWallet() {
  state.lockState = 'open';
  state.lastActive = Date.now();
  if (walletStarted) { render(); syncChain(6); return; }
  walletStarted = true;
  if (reqId && hasExt()) loadApproval();
  loadSites().then(render);
  render();
  syncChain(6);
  setInterval(() => { if (state.lockState === 'open' && !state.syncing && document.visibilityState === 'visible') syncChain(4); }, 60000);
}
async function lockNow() {
  await sessionClear();
  state.wallet = null; state.secret = null;
  location.reload(); // drops every key from memory
}
// auto-lock on inactivity
let lastTouch = 0;
function touch() {
  if (state.lockState !== 'open') return;
  state.lastActive = Date.now();
  if (Date.now() - lastTouch > 30000 && state.secret) { lastTouch = Date.now(); sessionSet(state.secret); }
}
['click', 'keydown'].forEach((ev) => document.addEventListener(ev, touch, true));
setInterval(() => {
  if (state.lockState === 'open' && readVault() && Date.now() - (state.lastActive || 0) > autoLockMins() * 60000) lockNow();
}, 15000);

// ---- screens ----
const logoBig = () => `<div class="lk-logo">${document.querySelector('.logo')?.innerHTML || ''}</div>`;
function viewLock() {
  return `<section class="lk">
    ${logoBig()}
    <h1>Welcome back</h1>
    <p class="muted">Enter your password to unlock MASKED.</p>
    <input type="password" id="pwUnlock" placeholder="Password" autocomplete="current-password" autofocus>
    ${statusLine('lock')}
    <button class="btn primary wide" id="btnUnlock" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Unlocking…' : 'Unlock'}</button>
    <button class="link small" data-forgot>Forgot password? Restore with your recovery phrase</button>
  </section>`;
}
function viewOnboard() {
  const mode = state.f.obMode;
  const replacing = !!readVault() || !!state.wallet;
  return `<section class="lk">
    ${logoBig()}
    <h1>${mode === 'restore' ? 'Restore wallet' : replacing ? 'New wallet' : 'Welcome to MASKED'}</h1>
    <p class="muted">${mode === 'restore' ? 'Enter your 12 or 24 recovery words.' : 'A Bitcoin wallet with a Shielded balance.'}</p>
    ${replacing ? '<p class="warn small">This replaces the wallet on this device. Make sure its recovery phrase is written down.</p>' : ''}
    ${seg('obMode', mode, [['create', 'Create new'], ['restore', 'Restore']])}
    <label class="field"><span class="lbl">Network</span>
      <select id="obNet">${Object.entries(NETS).map(([k, n]) => `<option value="${k}" ${(mode === 'restore' ? (savedNet() || (readVault() || state.wallet ? state.net : 'main')) : state.net) === k ? 'selected' : ''}>${n.name}${k === 'main' ? '' : ' (test coins)'}</option>`).join('')}</select>
      ${mode === 'restore' ? '<span class="muted small">Pick Mainnet to see the same address as in UniSat or other wallets. Test networks use different addresses.</span>' : ''}</label>
    ${mode === 'restore' ? `<label class="field"><span class="lbl">When did you first use this wallet?</span>
      <select id="obBday">${BIRTHDAYS.map(([v, l]) => `<option value="${v}" ${v === '30' ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span class="muted small">The wallet looks for Shielded payments back to then. Public coins and tokens show right away. Coming from UniSat, Xverse or another wallet without Shielded payments? Choose "Never used".</span></label>
      <textarea id="obWords" rows="3" spellcheck="false" autocomplete="off" placeholder="recovery words separated by spaces"></textarea>
      <input id="obPass" type="password" autocomplete="off" placeholder="BIP39 passphrase (optional, most people leave this empty)">` : ''}
    <input type="password" id="pwNew1" placeholder="New password (min 8 characters)" autocomplete="new-password">
    <input type="password" id="pwNew2" placeholder="Confirm password" autocomplete="new-password">
    <p class="info">The password encrypts your wallet on this device. It can't be recovered, but your recovery phrase can always restore the wallet.</p>
    ${statusLine('onboard')}
    <button class="btn primary wide" id="btnOnboard" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Encrypting…' : mode === 'restore' ? 'Restore wallet' : 'Create wallet'}</button>
    ${state.lockState === 'onboard-cancel' ? '<button class="btn ghost wide" data-obcancel>Cancel</button>' : ''}
  </section>`;
}
function viewSetPassword() {
  return `<section class="lk">
    ${logoBig()}
    <h1>Protect your wallet</h1>
    <p class="muted">MASKED now encrypts your wallet with a password. Set one to continue. Your coins and address stay the same.</p>
    <input type="password" id="pwNew1" placeholder="New password (min 8 characters)" autocomplete="new-password">
    <input type="password" id="pwNew2" placeholder="Confirm password" autocomplete="new-password">
    ${statusLine('onboard')}
    <button class="btn primary wide" id="btnMigrate" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Encrypting…' : 'Set password'}</button>
  </section>`;
}
function viewBackup() {
  const words = state.secret?.words || '';
  return `<section class="lk">
    <h1>Write down your recovery phrase</h1>
    <p class="warn small">These words are the only way to recover your wallet. Anyone who sees them can take your coins. Write them on paper and keep them offline.</p>
    <ol class="words">${words.split(' ').map((x) => `<li>${x}</li>`).join('')}</ol>
    ${copyBtn(words, 'Copy phrase')}
    <label class="risk ok-box"><input type="checkbox" data-backed ${state.f.backed ? 'checked' : ''}><span>I have written down my recovery phrase.</span></label>
    <button class="btn primary wide" id="btnBackedUp" ${state.f.backed ? '' : 'disabled'}>Continue</button>
  </section>`;
}
function securitySection() {
  if (!readVault()) return '';
  return `<section class="card menu">
    <button class="menu-row" data-lock-now><span>${I.lock}<b>Lock now</b></span><span class="chev">›</span></button>
    <div class="menu-row"><span>${I.lock}<b>Auto-lock after</b></span>
      <select id="autoLockSel">${[5, 15, 30, 60, 240].map((m) => `<option value="${m}" ${autoLockMins() === m ? 'selected' : ''}>${m < 60 ? `${m} min` : `${m / 60} h`}</option>`).join('')}</select></div>
    <details class="menu-det"><summary class="menu-row"><span>${I.gear}<b>Change password</b></span><span class="chev">›</span></summary>
      <div class="det-body">
        <input type="password" id="pwOld" placeholder="Current password" autocomplete="current-password">
        <input type="password" id="pwNew1" placeholder="New password (min 8 characters)" autocomplete="new-password">
        <input type="password" id="pwNew2" placeholder="Confirm new password" autocomplete="new-password">
        ${statusLine('pw')}
        <button class="btn primary wide" id="btnChangePw">Change password</button>
      </div>
    </details>
  </section>`;
}

// ---- actions ----
async function doUnlock() {
  const pw = $('#pwUnlock')?.value || '';
  state.busy = true; state.status.lock = null; render();
  try {
    const secret = await openVault(pw);
    useSecret(secret);
    await sessionSet(state.secret);
    state.busy = false;
    startWallet();
  } catch (e) { state.busy = false; state.status.lock = [e.message, 'err']; render(); $('#pwUnlock')?.focus(); }
}
function savedNet() { try { const n = localStorage.getItem('wren.net'); return NETS[n] ? n : ''; } catch { return ''; } }
async function doOnboard() {
  const p1 = $('#pwNew1').value, p2 = $('#pwNew2').value;
  try {
    let secret;
    if (state.f.obMode === 'restore') {
      const words = ($('#obWords').value || '').trim().toLowerCase().split(/\s+/).join(' ');
      if (!validateMnemonic(words, wordlist)) throw new Error('That recovery phrase is not valid. Check spelling and word count.');
      checkNewPassword(p1, p2);
      const days = Number($('#obBday')?.value);
      secret = { words, passphrase: $('#obPass').value || '', fresh: days === 0, restored: true, birthday: days > 0 ? Date.now() - days * 864e5 : days === 0 ? Date.now() : null };
    } else {
      checkNewPassword(p1, p2);
      secret = { words: generateMnemonic(wordlist, 128), passphrase: '', fresh: true, birthday: Date.now() };
    }
    const pickNet = $('#obNet')?.value;
    if (NETS[pickNet]) { state.net = pickNet; try { localStorage.setItem('wren.net', pickNet); } catch {} }
    state.busy = true; state.status.onboard = null; render();
    await sealVault(secret, p1);
    await sessionClear();
    useSecret(secret);
    resetWalletState();
    await sessionSet(state.secret);
    state.busy = false;
    if (secret.fresh && state.f.obMode !== 'restore') { state.lockState = 'backup'; state.f.backed = false; render(); }
    else { state.view = 'home'; startWallet(); }
  } catch (e) { state.busy = false; state.status.onboard = [e.message, 'err']; render(); }
}
async function doMigrate() {
  const p1 = $('#pwNew1').value, p2 = $('#pwNew2').value;
  try {
    checkNewPassword(p1, p2);
    state.busy = true; render();
    await sealVault(state.secret, p1);
    await sessionSet(state.secret);
    state.busy = false;
    toast('Wallet encrypted');
    startWallet();
  } catch (e) { state.busy = false; state.status.onboard = [e.message, 'err']; render(); }
}
async function doChangePassword() {
  try {
    const secret = await openVault($('#pwOld').value);
    checkNewPassword($('#pwNew1').value, $('#pwNew2').value);
    await sealVault(secret, $('#pwNew1').value);
    state.status.pw = ['Password changed.', 'ok'];
  } catch (e) { state.status.pw = [e.message, 'err']; }
  render();
}
async function doReveal() {
  if (state.reveal) { state.reveal = false; return render(); }
  try {
    if (readVault()) await openVault($('#pwReveal')?.value || '');
    state.reveal = true; state.status.reveal = null;
  } catch (e) { state.status.reveal = [e.message, 'err']; }
  render();
}

async function boot() {
  const vault = readVault();
  const legacy = readLegacy();
  if (vault) {
    const s = await sessionGet();
    if (s?.words && s.expires > Date.now()) { useSecret(s); await sessionSet(state.secret); startWallet(); return; }
    await sessionClear();
    try { const n = localStorage.getItem('wren.net'); if (NETS[n]) state.net = n; } catch {} // lock screen shows the wallet's network
    state.lockState = 'locked';
  } else if (legacy) {
    useSecret(legacy);
    state.lockState = 'migrate';
  } else {
    state.lockState = 'onboard';
    state.f.obMode = 'create';
  }
  render();
  setTimeout(() => $('#pwUnlock')?.focus(), 50);
}

// ---------- boot ----------
state.f = { recvKind: 'public', sendFrom: 'public', sendTo: '', sendAmount: '', fee: 'normal', feeCustom: '', mintTick: '', mintAmt: '', mintTo: 'self', mintOther: '', mintFrom: 'public', mintMode: 'mint', depTick: '', depMax: '21000000', depLim: '1000', depFrom: 'public', depResTo: 'shielded', depWho: 'self', recTick: '', recSalt: '', tsTick: '', tsTo: '', tsAmt: '', tsFrom: 'public', trTick: '', trAmt: '', trFrom: 'public', coinFilter: 'all', scanText: '', calcRecips: '' };
setSide(getSide()); // Send, Receive and Mint start on the side picked on Home
state.fees = { slow: 1, normal: 2, fast: 4 };
state.status = {};
state.send = { stage: 'form' };
state.mint = { stage: 'form' };
state.view = 'home';
try { const v = localStorage.getItem('wren.view'); if (NAV.some(([k]) => k === v)) state.view = v; } catch {}
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'pwUnlock') doUnlock(); });
boot();

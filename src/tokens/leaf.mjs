// LEAF, a CRC-20 token on Bitcoin mainnet (crc20.org). Balances belong to addresses, not to coins.
// A transfer is a plain transaction laid out exactly so: vin[0] spends a coin of the sender's address,
// vout[0] is one OP_RETURN with the JSON payload, vout[1] is the receiver, then BTC change.
// A transaction that breaks a rule still confirms on Bitcoin but moves no LEAF, so the layout is fixed here.

export const LEAF_DECIMALS = 8;
export const LEAF_API = 'https://crc20.org/api/v1';
/** Receiver output values the protocol asks for (dust limits). */
export const RECEIVER_SATS = { p2tr: 330, p2wpkh: 294 };
const enc = new TextEncoder();

/** "1,500.5" → 150050000000n atoms. Exact: more than 8 decimals is an error, never rounded. */
export function parseLeaf(text) {
  const t = String(text ?? '').trim().replace(/[,\s_]/g, '');
  const m = t.match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) throw new Error('Enter an amount of LEAF, like 1500 or 0.5.');
  const frac = m[2] || '';
  if (frac.length > LEAF_DECIMALS) throw new Error('LEAF has 8 decimals at most.');
  const atoms = BigInt(m[1] + frac.padEnd(LEAF_DECIMALS, '0'));
  if (atoms <= 0n) throw new Error('Enter an amount above zero.');
  if (atoms >= 2n ** 64n) throw new Error('That amount is too large.');
  return atoms;
}

/** 150050000000n → "1,500.5". */
export function fmtLeaf(atoms) {
  const v = BigInt(atoms ?? 0);
  const s = (v < 0n ? -v : v).toString().padStart(LEAF_DECIMALS + 1, '0');
  const whole = s.slice(0, -LEAF_DECIMALS), frac = s.slice(-LEAF_DECIMALS).replace(/0+$/, '');
  return (v < 0n ? '-' : '') + BigInt(whole).toLocaleString('en-US') + (frac ? '.' + frac : '');
}

/** The transfer payload: this exact key order, no spaces, amt as a decimal string of atoms. */
export function leafPayload(atoms) {
  if (typeof atoms !== 'bigint' || atoms <= 0n || atoms >= 2n ** 64n) throw new Error('LEAF amount out of range.');
  return `{"p":"crc-20","op":"transfer","tick":"LEAF","amt":"${atoms.toString()}"}`;
}

/** OP_RETURN + one direct push of the payload (at most 75 bytes, which every amount fits). */
export function leafScript(atoms) {
  const body = enc.encode(leafPayload(atoms));
  if (body.length > 75) throw new Error('LEAF payload too long.');
  return Uint8Array.from([0x6a, body.length, ...body]);
}

/**
 * Who can receive LEAF and what the receiver output carries. Only single-key outputs can send LEAF again,
 * so 1…, 3…, P2WSH and multisig are refused (LEAF sent there is stuck for good).
 * @param {Uint8Array} script the receiver's output script
 */
export function receiverKind(script) {
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return { kind: 'p2tr', sats: RECEIVER_SATS.p2tr };
  if (script.length === 22 && script[0] === 0x00 && script[1] === 0x14) return { kind: 'p2wpkh', sats: RECEIVER_SATS.p2wpkh };
  throw new Error('LEAF can only go to bc1p… or bc1q… (single-key) addresses, or a Shielded sp1… address. Anything else can never send it again.');
}

/** vsize of a signed transaction from its hex with and without witnesses. */
export function vsizeOf(fullHex, strippedHex) {
  const total = fullHex.length / 2, base = strippedHex.length / 2;
  return Math.ceil((base * 3 + total) / 4);
}

/**
 * The LEAF balance in an /addresses/{address} reply ({ address, leaf: { balance, decimals }, btc, height, axbt }),
 * as atoms. The API answers decimal strings
 * (never JSON numbers); an address with no activity answers "0".
 */
export function balanceFromReply(j) {
  const v = j?.leaf?.balance;
  if (typeof v === 'string' && /^\d+$/.test(v) && (j.leaf.decimals ?? LEAF_DECIMALS) === LEAF_DECIMALS) return BigInt(v);
  throw new Error('crc20.org answered in an unexpected format.');
}

/** /status: is the indexer at the chain tip? (Until then balances may be behind.) */
export const indexerSynced = (j) => j?.network === 'bitcoin' && j?.token?.tick === 'LEAF' && j?.indexer?.synced === true;

/**
 * A LEAF transfer in an Esplora transaction (unconfirmed or not): { txid, from, to, atoms }, or null when the
 * transaction is not one. Same rules as the indexer: vout[0] is the exact payload, vout[1] the receiver.
 */
export function leafTransferOf(tx) {
  const op = tx?.vout?.[0]?.scriptpubkey, recv = tx?.vout?.[1];
  if (typeof op !== 'string' || !op.startsWith('6a') || !recv?.scriptpubkey_address) return null;
  const len = parseInt(op.slice(2, 4), 16);
  if (!(len > 0 && len <= 75) || op.length !== 4 + len * 2) return null;
  let text = '';
  for (let i = 4; i < op.length; i += 2) text += String.fromCharCode(parseInt(op.slice(i, i + 2), 16));
  const m = text.match(/^\{"p":"crc-20","op":"transfer","tick":"LEAF","amt":"(\d+)"\}$/);
  if (!m) return null;
  return { txid: tx.txid, from: tx.vin?.[0]?.prevout?.scriptpubkey_address || null, to: recv.scriptpubkey_address, atoms: BigInt(m[1]) };
}

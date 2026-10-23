// Reading a raw transaction (segwit or legacy): its txid, inputs and outputs. Strict: anything that is not
// exactly one well-formed transaction is refused.
import { concat, fromHex, rev, sha256d, toHex } from '../core/bytes.mjs';

/** The longest hex run in some text (a signed payment pasted with words around it), or ''. */
export function findTxHex(text) {
  const runs = String(text || '').match(/[0-9a-fA-F]{120,}/g) || [];
  return runs.sort((a, b) => b.length - a.length)[0]?.toLowerCase() || '';
}

/**
 * @param {string} hex
 * @returns {{ txid: string, inputs: { txid: string, vout: number, witness: Uint8Array[] }[], outputs: { value: number, script: Uint8Array }[], vsize: number, segwit: boolean }}
 */
export function parseTx(hex) {
  if (!/^([0-9a-f]{2})+$/i.test(hex || '')) throw new Error('Not a transaction (expected hex).');
  const b = fromHex(hex.toLowerCase());
  if (b.length < 60 || b.length > 100_000) throw new Error('That is not a normal transaction size.');
  let i = 0;
  const rd = (n) => { if (i + n > b.length) throw new Error('Transaction is cut short.'); const s = b.slice(i, i + n); i += n; return s; };
  const vi = () => {
    const f = rd(1)[0];
    if (f < 0xfd) return f;
    const n = f === 0xfd ? 2 : f === 0xfe ? 4 : 8, s = rd(n);
    let v = 0; for (let j = n - 1; j >= 0; j--) v = v * 256 + s[j];
    return v;
  };
  const version = rd(4);
  let segwit = false;
  if (b[i] === 0 && b[i + 1] === 1) { segwit = true; i += 2; }
  const ioStart = i;
  const nIn = vi();
  if (!nIn || nIn > 2000) throw new Error('Transaction has no inputs.');
  const inputs = [];
  for (let k = 0; k < nIn; k++) {
    const txid = toHex(rev(rd(32)));
    const vout = new DataView(rd(4).buffer).getUint32(0, true);
    rd(vi()); rd(4);
    inputs.push({ txid, vout, witness: [] });
  }
  const nOut = vi();
  if (!nOut || nOut > 2000) throw new Error('Transaction has no outputs.');
  const outputs = [];
  for (let k = 0; k < nOut; k++) {
    const v = rd(8); let value = 0; for (let j = 7; j >= 0; j--) value = value * 256 + v[j];
    outputs.push({ value, script: rd(vi()) });
  }
  const ioEnd = i;
  if (segwit) for (const inp of inputs) { const n = vi(); for (let m = 0; m < n; m++) inp.witness.push(rd(vi())); }
  const lock = rd(4);
  if (i !== b.length) throw new Error('Transaction has extra bytes at the end.');
  const stripped = concat(version, b.slice(ioStart, ioEnd), lock);
  const weight = stripped.length * 3 + b.length;
  return { txid: toHex(rev(sha256d(stripped))), inputs, outputs, vsize: Math.ceil(weight / 4), segwit };
}

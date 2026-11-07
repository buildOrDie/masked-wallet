// PSBTs from dApps: what they do to this wallet, and signing the inputs that are ours. The Public address
// signs with its BIP 86 key; the private trade address and listed Shielded holders sign with their raw key
// (no taproot tweak), for MASKED's own website only (the approval checks the origin).
import * as btc from '@scure/btc-signer';
import * as trade from '../trade/trade-core.mjs';
import { fromHex, toHex } from '../core/bytes.mjs';
import { INSCRIPTION_MAX } from '../ordinals/envelope.mjs';
import { sighashRisk } from '../security/guard.mjs';

/** Signature types MASKED understands (Taproot: 0 = DEFAULT). Anything else, and anything not an integer, is refused. */
const SIGHASHES = new Set([0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83]);
/** @param {unknown} list what the site sent (toSignInputs[].sighashTypes) */
export function checkSighashes(list, i) {
  if (!Array.isArray(list) || list.length > 4 || !list.every((t) => Number.isInteger(t) && SIGHASHES.has(t))) throw new Error(`Input ${i}: unsupported signature type. MASKED only signs standard SIGHASH values.`);
  return list.map(Number);
}
/**
 * Which outputs a signature with these types covers. DEFAULT/ALL cover every output; SINGLE covers only the output
 * with the same index as the input. With several allowed types, the weakest counts.
 * @returns {'all'|'single'}
 */
export function commitment(types) {
  const list = types?.length ? types : [0x00];
  return list.some((t) => (t & 0x1f) === 0x03) ? 'single' : 'all';
}

export class PsbtSigner {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) { this.app = app; }

  get account() { return this.app.account; }
  get coins() { return this.app.coins; }

  /** Read a PSBT and work out what it does to this wallet. */
  analyse(psbtHex, options = {}) {
    const tx = btc.Transaction.fromPSBT(fromHex(psbtHex), { allowUnknownOutputs: true, allowUnknownInputs: true });
    const codec = this.account.codec, tradeAcct = this.app.trade, ord = this.app.ord;
    const ourSpk = this.account.pubSpk();
    const want = Array.isArray(options.toSignInputs) && options.toSignInputs.length ? options.toSignInputs : null;
    const isRisky = (c) => c && (this.coins.isProtected(c) || ord.unverified(c));
    const inputs = [], outputs = [];
    let spent = 0, received = 0;
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      const txid = inp.txid ? toHex(inp.txid) : '';
      const value = inp.witnessUtxo ? Number(inp.witnessUtxo.amount) : null;
      const spk = inp.witnessUtxo ? toHex(inp.witnessUtxo.script) : null;
      const tk = spk && spk !== ourSpk ? tradeAcct.keyPathFor(spk) : null; // the private trade address, or a listed Shielded holder
      const ours = spk === ourSpk || !!tk;
      const w = want?.find((x) => x.index === i);
      const sign = want ? !!w : ours;
      if (w && !ours) throw new Error(`Input ${i} does not belong to this wallet's Public or trade address.`);
      if (w?.disableTweakSigner) throw new Error('Script-path signing (disableTweakSigner) is not supported yet.');
      const coin = tk ? null : this.coins.public.find((c) => c.txid === txid && c.vout === inp.index);
      const tcoin = tk ? this.coins.trade.find((c) => c.txid === txid && c.vout === inp.index) : null;
      const prot = ours && (isRisky(coin) || isRisky(tcoin) || (value != null && value <= INSCRIPTION_MAX));
      const fromSite = w?.sighashTypes != null ? checkSighashes(w.sighashTypes, i) : [];
      const fromPsbt = inp.sighashType != null ? checkSighashes([inp.sighashType], i) : [];
      // the signature uses the PSBT's own type if set; judge by every type in play
      const sighash = [...new Set([...fromPsbt, ...fromSite])];
      const sighashOrNull = sighash.length ? sighash : null;
      // SIGHASH_NONE signs no outputs: the site could send these coins anywhere. Never.
      if (sign && sighashRisk(sighashOrNull) === 'blank-cheque') throw new Error(`This site asks you to sign input ${i} with SIGHASH_NONE, which would let it send those coins anywhere. MASKED refuses to sign it.`);
      if (ours) spent += value || 0;
      inputs.push({ i, txid, vout: inp.index, value, address: spk ? codec.fromScript(fromHex(spk)) : null, ours, keyed: tk ? tk.kind : null, spk, trade: tk?.kind === 'trade' ? tk.index : null, sign, prot: !!prot, sighash: sighashOrNull, covers: commitment(sighashOrNull), finalized: !!inp.finalScriptWitness });
    }
    const toSign = inputs.filter((x) => x.sign);
    // Outputs our signatures lock in. One DEFAULT/ALL signature locks every output; SINGLE locks only its own index.
    // An output nothing of ours covers can be changed after we sign, so it is never counted as money coming back.
    const coversAll = toSign.some((x) => x.covers === 'all');
    const single = new Set(toSign.filter((x) => x.covers === 'single').map((x) => x.i));
    for (let i = 0; i < tx.outputsLength; i++) {
      const o = tx.getOutput(i);
      const tk = tradeAcct.keyPathFor(toHex(o.script));
      const ours = toHex(o.script) === ourSpk || !!tk;
      const locked = coversAll || single.has(i);
      if (ours && locked) received += Number(o.amount);
      outputs.push({ i, value: Number(o.amount), address: codec.fromScript(o.script) || (o.script[0] === 0x6a ? 'OP_RETURN' : 'unknown'), ours, locked, keyed: tk ? tk.kind : null, trade: tk?.kind === 'trade' ? tk.index : null });
    }
    const unusual = toSign.filter((x) => sighashRisk(x.sighash) === 'unusual').length;
    // partial: the site can change or add outputs after we sign. Always asked about, never just shown.
    const partial = toSign.length > 0 && !coversAll;
    const changeable = outputs.filter((o) => !o.locked);
    return { tx, inputs, outputs, toSign, net: received - spent, protectedCount: toSign.filter((x) => x.prot).length + unusual + (partial ? 1 : 0), unusual, partial, changeable: changeable.length, changeableOurs: changeable.filter((o) => o.ours).reduce((n, o) => n + o.value, 0), trade: toSign.some((x) => x.keyed) };
  }

  sign(psbtHex, options = {}) {
    const a = this.analyse(psbtHex, options);
    if (!a.toSign.length) throw new Error('Nothing in this PSBT for this wallet to sign.');
    const finalize = options.autoFinalized !== false;
    const internal = fromHex(this.account.funding().internalX);
    // trade address inputs: the output key is the key itself (no taproot tweak)
    const keyed = a.toSign.filter((x) => x.keyed);
    if (keyed.length) trade.signKeyPathInputs(a.tx, keyed.map((x) => ({ i: x.i, priv: this.app.trade.keyPathFor(x.spk).priv, sighash: x.sighash?.[0] })), { finalize });
    const priv = this.account.keys.accountPriv();
    for (const x of a.toSign) {
      if (x.keyed) continue;
      if (!a.tx.getInput(x.i).tapInternalKey) a.tx.updateInput(x.i, { tapInternalKey: internal });
      a.tx.signIdx(priv, x.i, x.sighash || undefined);
      if (finalize) a.tx.finalizeIdx(x.i);
    }
    return toHex(a.tx.toPSBT());
  }
}

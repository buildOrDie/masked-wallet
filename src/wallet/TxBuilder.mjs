// Building and signing the wallet's own transactions: plain sends (also into Shielded) and inscriptions
// (commit + reveal, optionally spending a parent inscription). Nothing is broadcast here.
import * as sp from '../crypto/sp-core.mjs';
import { dec, toHex, ZERO32 } from '../core/bytes.mjs';
import { fmtBtc } from '../core/format.mjs';
import { RawTransaction } from '../bitcoin/RawTransaction.mjs';
import { normalizeSchnorrPriv, p2trScript, taprootScriptOutput, xonly } from '../bitcoin/taproot.mjs';
import { CT_TEXT, DEFAULT_REVEAL_VALUE, DUST_CHANGE, estimateOrdinalMint, estimateSimpleSend, inscriptionScript } from '../ordinals/envelope.mjs';
import { parentIdBytes } from '../ordinals/brc20.mjs';
import { pickCoin } from './CoinStore.mjs';

const { b2n, mulG } = sp.util;

const sideName = (from) => (from === 'shielded' ? 'Shielded' : from === 'trade' ? 'trade address' : 'Public');

/** A coin as a transaction input. */
export const inputOf = (c) => ({ txid: c.txid, vout: c.vout, value: c.sats, scriptPubKey: p2trScript(c.output) });

/** Silent-payment outputs for some recipients, handed out one recipient at a time. */
export class SilentOutputs {
  constructor(keys, outpoints, recipients) {
    this.list = recipients.length ? sp.createOutputs(keys, outpoints, recipients) : [];
  }
  /** The output script for a recipient (each derived output is used once). */
  take(address) {
    return p2trScript(this.list.splice(this.list.findIndex((d) => d.address === address), 1)[0].output);
  }
}

export class TxBuilder {
  /** @param {import('../app/MaskedApp.mjs').MaskedApp} app */
  constructor(app) { this.app = app; }

  get account() { return this.app.account; }
  get coins() { return this.app.coins; }

  /** A coin's private key: Public coins carry it, Shielded ones derive it from the spend key and their tweak. */
  privOf(coin) { return coin.privKey || this.account.keys.outputPriv(coin.tweak); }

  requireSigner(what) {
    if (!this.account.canSign) throw new Error(`This wallet is watch-only and cannot ${what}.`);
  }

  /** One coin in, the payment and (when worth it) change out. Shielded change stays Shielded. */
  async send({ from, to, amount, rate }) {
    this.requireSigner('send');
    await this.coins.ensureOrd(from);
    const label = from === 'shielded' ? 'Shielded' : 'Public';
    const unit = this.account.unit;
    const list = this.coins.spendable(from);
    if (!list.length) throw new Error(`Your ${label} balance is empty.`);
    const recipient = to === 'self' ? this.account.shieldAddr() : String(to).trim();
    const k = this.account.codec.kind(recipient);
    if (k.kind === 'empty') throw new Error('Enter who to send to.');
    if (k.kind !== 'public' && k.kind !== 'shielded') throw new Error(k.text + '.');
    if (!Number.isSafeInteger(amount) || amount < 546) throw new Error(`Minimum is 0.00000546 ${unit}.`);
    const feeOf = (n, outs) => estimateSimpleSend({ inputs: n, outputs: outs, feeRate: rate });
    // one coin when one is enough (the usual case); otherwise several, largest first (small unlocked coins join in)
    let coins = [pickCoin(list, amount + feeOf(1, 2) + DUST_CHANGE) || pickCoin(list, amount + feeOf(1, 1))].filter(Boolean);
    if (!coins.length) {
      const byValue = [...list].sort((a, b) => b.sats - a.sats);
      let sum = 0;
      for (const c of byValue) { coins.push(c); sum += c.sats; if (sum >= amount + feeOf(coins.length, 1)) break; }
      if (sum < amount + feeOf(coins.length, 1)) coins = [];
    }
    if (!coins.length) throw new Error(`Not enough ${label} balance. You can send up to ${fmtBtc(this.coins.maxSendable(from, this.app.feeRate()))} ${unit}.`);
    const n = coins.length, inSum = coins.reduce((a, c) => a + c.sats, 0);
    const keys = coins.map((c) => this.privOf(c));
    const feeTwo = feeOf(n, 2);
    const wantChange = inSum - amount - feeTwo >= DUST_CHANGE;
    // Shielded change goes back to the wallet's own change address (label 0) so it stays private.
    const changeShielded = wantChange && from === 'shielded';
    const change = this.account.changeAddr();
    const silent = [];
    if (k.kind === 'shielded') silent.push(recipient);
    if (changeShielded) silent.push(change);
    const derived = new SilentOutputs(coins.map((c, i) => ({ txid: c.txid, vout: c.vout, privKey: keys[i], taproot: true })), coins.map((c) => ({ txid: c.txid, vout: c.vout })), silent);
    const outputs = [{ value: amount, script: k.kind === 'shielded' ? derived.take(recipient) : this.account.codec.outputScript(recipient) }];
    let fee = inSum - amount;
    if (wantChange) {
      fee = feeTwo;
      outputs.push({ value: inSum - amount - feeTwo, script: changeShielded ? derived.take(change) : p2trScript(coins[0].output) });
    }
    const tx = new RawTransaction({ inputs: coins.map(inputOf), outputs });
    const hex = tx.toHex(keys.map((k2, i) => [tx.signKeyPath(i, k2)]));
    return { hex, txid: tx.txid, amount, fee, coin: coins[0], coins, spent: coins.map((c) => c.key), from, recipient, kind: k.kind, toSelf: to === 'self' };
  }

  /**
   * Commit + reveal of one inscription.
   * - `parent`: also spend this inscription in the reveal and return it to its owner (BRC2.0 deploys, self-mints).
   * - `rawRecipientScript`: inscribe onto an exact output script we control (e.g. a BRC-20 balance holder).
   * - `revealExtra`: extra sats on the inscription, so a follow-up transaction can pay its own fee.
   */
  async inscription({ from, body, recipient, rate, parent = null, parentId = null, meta = {}, rawRecipientScript = null, revealExtra = 0, postage = DEFAULT_REVEAL_VALUE }) {
    this.requireSigner('inscribe');
    await this.coins.ensureOrd(from);
    const account = this.account, codec = account.codec;
    const k = rawRecipientScript ? { kind: 'raw' } : codec.kind(recipient);
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
    const label = sideName(from);
    const list = this.coins.spendable(from).filter((c) => !parent || c.key !== parent.key);
    if (!list.length) throw new Error(`Your ${label} balance is empty.`);
    const coin = [...list].sort((a, b) => a.sats - b.sats).find((c) => est(c.sats, probeLen).change >= 0);
    if (!coin) { const e = est(0, probeLen); throw new Error(`Not enough ${label} balance. This needs about ${fmtBtc(e.totalFee + e.revealValue)} ${account.unit}.`); }
    const fundingPriv = this.privOf(coin);
    const revealPub = xonly(mulG(b2n(normalizeSchnorrPriv(fundingPriv))));
    const script = inscriptionScript(revealPub, CT_TEXT, body, pBytes);
    const tap = taprootScriptOutput(fundingPriv, script);
    const estimate = est(coin.sats, body.length + script.length);

    // commit: the coin → the inscription output (+ change)
    const commitOutputs = [{ value: estimate.revealValue + estimate.revealFee, script: p2trScript(tap.outputX) }];
    if (estimate.change >= DUST_CHANGE) {
      let changeScript = p2trScript(coin.output);
      if (from === 'shielded') changeScript = new SilentOutputs([{ txid: coin.txid, vout: coin.vout, privKey: fundingPriv, taproot: true }], [{ txid: coin.txid, vout: coin.vout }], [account.changeAddr()]).take(account.changeAddr());
      commitOutputs.push({ value: estimate.change, script: changeScript });
    } else {
      estimate.commitFee += estimate.change; estimate.totalFee += estimate.change; estimate.change = 0;
    }
    const commitTx = new RawTransaction({ inputs: [inputOf(coin)], outputs: commitOutputs });
    const commitHex = commitTx.toHex([[commitTx.signKeyPath(0, fundingPriv)]]);
    const commitTxid = commitTx.txid;

    // reveal: [parent,] commit → [parent back,] the inscription
    const commitIn = { txid: commitTxid, vout: 0, value: estimate.revealValue + estimate.revealFee, scriptPubKey: p2trScript(tap.outputX) };
    // Parent goes first so its sat lands in output 0; the new inscription (input 1) lands in output 1.
    const inputs = parent ? [inputOf(parent), commitIn] : [commitIn];
    const silent = [];
    if (parent?.shielded) silent.push(account.changeAddr());
    if (k.kind === 'shielded') silent.push(recipient);
    const keys = [...(parent ? [{ txid: parent.txid, vout: parent.vout, privKey: parent.privKey, taproot: true }] : []), { txid: commitTxid, vout: 0, privKey: tap.outputPriv, taproot: true }];
    const derived = new SilentOutputs(keys, inputs.map((i) => ({ txid: i.txid, vout: i.vout })), silent);
    const parentBack = parent ? (parent.shielded ? derived.take(account.changeAddr()) : p2trScript(parent.output)) : null;
    const recipientScript = k.kind === 'raw' ? rawRecipientScript : k.kind === 'shielded' ? derived.take(recipient) : codec.outputScript(recipient);
    const outputs = parent ? [{ value: parent.sats, script: parentBack }, { value: estimate.revealValue, script: recipientScript }] : [{ value: estimate.revealValue, script: recipientScript }];
    const revealTx = new RawTransaction({ inputs, outputs });
    const ci = parent ? 1 : 0;
    const witnesses = [];
    if (parent) witnesses.push([revealTx.signKeyPath(0, parent.privKey)]);
    witnesses[ci] = [revealTx.signScriptPath(ci, tap.internalPriv, tap.leafHash), script, tap.controlBlock];
    const revealHex = revealTx.toHex(witnesses);
    const revealTxid = revealTx.txid;
    return {
      ...meta, coin, from, recipient, kind: k.kind, toSelf: recipient === account.shieldAddr(), body: dec.decode(body), estimate,
      commitHex, commitTxid, revealHex, revealTxid, revealOut: ci, recipientSpk: toHex(recipientScript), inscriptionId: `${revealTxid}i0`, spent: [coin.key, ...(parent ? [parent.key] : [])],
    };
  }
}


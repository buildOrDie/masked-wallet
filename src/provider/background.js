// MASKED background service worker.
// Owns: the list of connected sites, request routing, approval windows and dApp events.
// It never sees private keys. Anything that needs a key opens the wallet in an approval window,
// where the user approves or rejects and the wallet page does the signing.
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';

const NETS = {
  main: { ord: 'https://ordinals.com', api: 'https://mempool.space/api/', unisat: 'livenet', chain: 'BITCOIN_MAINNET', name: 'Bitcoin Mainnet' },
  signet: { ord: 'https://signet.ordinals.com', api: 'https://mempool.space/signet/api/', unisat: 'testnet', chain: 'BITCOIN_SIGNET', name: 'Bitcoin Signet' },
};
// MASKED runs on Mainnet and Signet. UniSat reports Signet as "testnet", so that name maps to Signet.
const FROM_UNISAT = { livenet: 'main', mainnet: 'main', testnet: 'signet', signet: 'signet' };
const FROM_CHAIN = { BITCOIN_MAINNET: 'main', BITCOIN_SIGNET: 'signet' };
const APPROVAL = new Set(['requestAccounts', 'signMessage', 'signPsbt', 'signPsbts', 'sendBitcoin', 'switchNetwork', 'switchChain', 'inscribeTransfer', 'getTradeAccount', 'fundTradeAccount', 'moveToTradeAccount', 'returnToShielded']);

const TRADE_SITES = new Set(['https://maskedwallet.com', 'https://www.maskedwallet.com']);
const err = (code, message) => Object.assign(new Error(message), { code });
const pending = new Map(); // id -> { origin, method, params, resolve, reject, windowId }
const ports = new Set();   // { port, origin }

async function getPublic() { return (await chrome.storage.local.get('masked.public'))['masked.public'] || null; }
async function getTrade() { return (await chrome.storage.local.get('masked.trade'))['masked.trade'] || null; }
async function getSites() { return (await chrome.storage.local.get('masked.sites'))['masked.sites'] || {}; }
async function setSites(s) { await chrome.storage.local.set({ 'masked.sites': s }); }
const chainInfo = (net) => ({ enum: NETS[net].chain, name: NETS[net].name, network: NETS[net].unisat });

// Approvals open in MASKED's own toolbar popup (like other wallets). If Chrome cannot open it
// (older Chrome, no focused window), a small popup window is used instead.
const POPUP = 'masked.html';
async function resetPopup() { if (![...pending.values()].some((p) => p.mode === 'popup')) await chrome.action.setPopup({ popup: POPUP }).catch(() => {}); }
async function showApproval(id) {
  const url = `masked.html?req=${id}`;
  if (chrome.action?.openPopup) {
    try {
      await chrome.action.setPopup({ popup: url });
      await Promise.race([chrome.action.openPopup(), new Promise((_, no) => setTimeout(() => no(new Error('popup timeout')), 1500))]);
      // make sure it really opened (Chrome can resolve without showing it, e.g. when minimised)
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const ctx = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ['POPUP'] }) : [{ documentUrl: url }];
        if (ctx.some((c) => String(c.documentUrl || '').includes(id))) return { mode: 'popup' };
      }
      throw new Error('popup did not open');
    } catch { await chrome.action.setPopup({ popup: POPUP }).catch(() => {}); }
  }
  const win = await chrome.windows.create({ url: chrome.runtime.getURL(url), type: 'popup', width: 380, height: 660, focused: true });
  return { mode: 'window', windowId: win.id };
}
function openApproval(origin, method, params) {
  return new Promise(async (resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { origin, method, params, resolve, reject, windowId: null, mode: null });
    try {
      const shown = await showApproval(id);
      const p = pending.get(id);
      if (p) Object.assign(p, shown);
    } catch (e) {
      pending.delete(id); resetPopup();
      reject(err(4000, 'Could not open the MASKED approval window.'));
    }
  });
}
function rejectPending(id, message = 'User rejected the request.') {
  const p = pending.get(id); if (!p) return;
  pending.delete(id); p.reject(err(4001, message)); resetPopup();
}
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, p] of pending) if (p.windowId === windowId) rejectPending(id);
});
// the approval page keeps a port open; closing the toolbar popup closes it, which rejects the request
chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('approval:') || port.sender?.id !== chrome.runtime.id) return;
  const id = port.name.slice(9);
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; } );
  port.onDisconnect.addListener(() => setTimeout(() => { if (pending.get(id)?.mode === 'popup') rejectPending(id); }, 300));
});

async function api(net, path, init) {
  const r = await fetch(NETS[net].api + path, init);
  const t = await r.text();
  if (!r.ok) throw err(4000, t || `Network error ${r.status}`);
  return t;
}

const checkTicker = (t) => {
  const ticker = String(t || '').trim();
  if (!ticker || new TextEncoder().encode(ticker).length > 6) throw err(4000, 'ticker must be a BRC-20 (4) or BRC2.0 (5-6) ticker.');
  return ticker;
};
const checkAmount = (a) => { if (!/^\d+(\.\d+)?$/.test(String(a || '')) || /^0+(\.0+)?$/.test(String(a))) throw err(4000, 'amount must be a positive number.'); return String(a); };
/** What a site sees of private trading: the trade address and the Shielded totals. */
const tradeView = (t) => ({ address: t.address, publicKey: t.publicKey, index: t.index, features: t.features || [], shielded: { sats: t.shielded?.sats || 0, tokens: (t.shielded?.tokens || []).map((x) => ({ ticker: x.tick, amount: String(x.amt) })), transfers: t.shielded?.transfers || [] } });

async function handle(origin, method, params) {
  const pub = await getPublic();
  if (!pub?.address) throw err(4100, 'Open MASKED and set up a wallet first.');
  const net = pub.net;
  const sites = await getSites();
  const connected = !!sites[origin];
  const needConnected = () => { if (!connected) throw err(4100, 'This site is not connected. Call requestAccounts() first.'); };
  const needTrade = () => { tradeSite(); if (!sites[origin]?.trade) throw err(4100, 'Private trading is not allowed for this site. Call getTradeAccount() first.'); };
  // private trading is offered to MASKED's own website only, for now
  const tradeSite = () => { if (!TRADE_SITES.has(origin)) throw err(4200, 'Private trading is not available on this site.'); };

  switch (method) {
    case 'getNetwork': return NETS[net].unisat;
    case 'getChain': return chainInfo(net);
    case 'getAccounts': return connected ? [pub.address] : [];
    case 'requestAccounts': {
      if (connected) return [pub.address];
      const res = await openApproval(origin, 'requestAccounts', {});
      const s = await getSites();
      s[origin] = { connectedAt: Date.now() };
      await setSites(s);
      return res;
    }
    case 'disconnect': {
      const s = await getSites(); delete s[origin]; await setSites(s);
      emitTo(origin, 'accountsChanged', []);
      return true;
    }
    case 'getPublicKey': needConnected(); return pub.publicKey;
    case 'getShieldedAddress': needConnected(); return pub.shieldedAddress;
    case 'getBalance': {
      needConnected();
      const a = JSON.parse(await api(net, `address/${pub.address}`));
      const confirmed = a.chain_stats.funded_txo_sum - a.chain_stats.spent_txo_sum;
      const unconfirmed = a.mempool_stats.funded_txo_sum - a.mempool_stats.spent_txo_sum;
      return { confirmed, unconfirmed, total: confirmed + unconfirmed };
    }
    case 'switchNetwork': {
      needConnected();
      const target = FROM_UNISAT[String(params.network || '').toLowerCase()];
      if (!target) throw err(4000, `Unknown network "${params.network}". MASKED supports livenet (Mainnet) and signet.`);
      if (target === net) return NETS[net].unisat;
      await openApproval(origin, 'switchNetwork', { target });
      return NETS[target].unisat;
    }
    case 'switchChain': {
      needConnected();
      const target = FROM_CHAIN[params.chain];
      if (!target) throw err(4000, `Unsupported chain "${params.chain}". MASKED supports BITCOIN_MAINNET and BITCOIN_SIGNET.`);
      if (target === net) return chainInfo(net);
      await openApproval(origin, 'switchNetwork', { target });
      return chainInfo(target);
    }
    case 'signMessage':
      needConnected();
      if (typeof params.message !== 'string') throw err(4000, 'message must be a string.');
      if (!['ecdsa', 'bip322-simple'].includes(params.type)) throw err(4000, 'type must be "ecdsa" or "bip322-simple".');
      return openApproval(origin, 'signMessage', params);
    case 'signPsbt':
      needConnected();
      if (!/^[0-9a-fA-F]+$/.test(params.psbtHex || '')) throw err(4000, 'psbtHex must be a hex string.');
      return openApproval(origin, 'signPsbt', params);
    case 'signPsbts':
      needConnected();
      if (!Array.isArray(params.psbtHexs) || !params.psbtHexs.length) throw err(4000, 'psbtHexs must be a non-empty array.');
      return openApproval(origin, 'signPsbts', params);
    case 'sendBitcoin':
      needConnected();
      if (!Number.isSafeInteger(Number(params.satoshis)) || Number(params.satoshis) <= 0) throw err(4000, 'satoshis must be a positive integer.');
      return openApproval(origin, 'sendBitcoin', params);
    case 'getInscriptions': {
      needConnected();
      const cursor = Math.max(0, Number(params.cursor) || 0), size = Math.min(100, Math.max(1, Number(params.size) || 20));
      const ord = NETS[net].ord;
      const getJ = async (u) => { const r = await fetch(u, { headers: { Accept: 'application/json' } }); if (!r.ok) throw err(4000, `Inscription lookup failed (${r.status}).`); return r.json(); };
      const ids = (await getJ(`${ord}/address/${pub.address}`)).inscriptions || [];
      const list = await Promise.all(ids.slice(cursor, cursor + size).map(async (id) => {
        try {
          const i = await getJ(`${ord}/inscription/${id}`);
          const [txid, vout, offset] = String(i.satpoint || '').split(':');
          return { inscriptionId: id, inscriptionNumber: i.number ?? null, address: i.address || pub.address, outputValue: i.value ?? null, contentType: i.content_type || null, content: `${ord}/content/${id}`, preview: `${ord}/preview/${id}`, timestamp: i.timestamp ?? null, output: txid ? `${txid}:${vout}` : null, offset: offset != null ? Number(offset) : 0, genesisTransaction: String(id).slice(0, 64) };
        } catch { return { inscriptionId: id }; }
      }));
      return { total: ids.length, list };
    }
    case 'inscribeTransfer': {
      needConnected();
      const ticker = checkTicker(params.ticker), amount = checkAmount(params.amount);
      const account = ['trade', 'shielded'].includes(params.options?.account) ? params.options.account : 'public';
      if (account !== 'public') needTrade();
      return openApproval(origin, 'inscribeTransfer', { ticker, amount, options: { account } });
    }
    // ---- private trading: a private trade address made from the Shielded keys (see trade-core.mjs) ----
    case 'getTradeAccount': {
      needConnected(); tradeSite();
      const t = await getTrade();
      if (sites[origin]?.trade && t?.address && t.net === NETS[net].unisat) return tradeView(t);
      const res = await openApproval(origin, 'shareTrade', {});
      const s = await getSites();
      if (s[origin]) { s[origin].trade = true; await setSites(s); }
      return tradeView(res);
    }
    case 'fundTradeAccount': {
      needConnected(); needTrade();
      const satoshis = Number(params.satoshis) || 0;
      if (!Number.isSafeInteger(satoshis) || satoshis < 0 || (!satoshis && !params.padding)) throw err(4000, 'satoshis must be a positive integer.');
      return openApproval(origin, 'fundTrade', { satoshis, padding: !!params.padding, feeRate: Number(params.feeRate) || undefined });
    }
    case 'moveToTradeAccount':
      needConnected(); needTrade();
      return openApproval(origin, 'moveToTrade', { ticker: checkTicker(params.ticker), amount: checkAmount(params.amount) });
    case 'cancelShieldedListing':
      needConnected(); needTrade();
      if (!/^[0-9a-f]{64}:\d{1,6}$/i.test(String(params.outpoint || ''))) throw err(4000, 'outpoint must be "txid:vout".');
      return openApproval(origin, 'cancelShielded', { outpoint: String(params.outpoint).toLowerCase() });
    case 'returnToShielded':
      needConnected(); needTrade();
      return openApproval(origin, 'returnToShielded', params.ticker ? { ticker: checkTicker(params.ticker), amount: checkAmount(params.amount) } : {});
    case 'pushTx': {
      needConnected();
      if (!/^[0-9a-fA-F]+$/.test(params.rawtx || '')) throw err(4000, 'rawtx must be a hex string.');
      return (await api(net, 'tx', { method: 'POST', body: params.rawtx })).trim();
    }
    case 'pushPsbt': {
      needConnected();
      const tx = btc.Transaction.fromPSBT(hex.decode(params.psbtHex), { allowUnknownOutputs: true });
      try { tx.finalize(); } catch {}
      return (await api(net, 'tx', { method: 'POST', body: tx.hex })).trim();
    }
    default: throw err(4200, `Method ${method} is not supported by MASKED.`);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'masked-rpc') return;
  const url = port.sender?.url || '';
  let origin;
  try { origin = port.sender?.origin || new URL(url).origin; } catch { origin = 'unknown'; }
  const entry = { port, origin };
  ports.add(entry);
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; ports.delete(entry); });
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.ping || msg.hello || typeof msg.id !== 'string') return;
    try {
      const result = await handle(origin, msg.method, msg.params || {});
      port.postMessage({ id: msg.id, result });
    } catch (e) {
      port.postMessage({ id: msg.id, error: { code: e.code ?? 4000, message: e.message || String(e) } });
    }
  });
});

// The wallet page (approval window) asks for its request and returns the answer here.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url?.startsWith('http')) return; // extension pages only
  if (msg?.type === 'getRequest') {
    const p = pending.get(msg.id);
    sendResponse(p ? { origin: p.origin, method: p.method, params: p.params } : null);
    return;
  }
  if (msg?.type === 'resolveRequest') {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(err(msg.error.code ?? 4001, msg.error.message || 'User rejected the request.'));
      else p.resolve(msg.result);
      if (p.windowId != null) chrome.windows.remove(p.windowId).catch(() => {});
      resetPopup();
    }
    sendResponse(true);
  }
});

async function emitTo(origin, event, data) {
  for (const { port, origin: o } of ports) if (o === origin) { try { port.postMessage({ event, data }); } catch {} }
}
// Tell connected sites when the account or network changes in the wallet.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes['masked.trade']) return;
  const after = changes['masked.trade'].newValue;
  const sites = await getSites();
  for (const { port, origin } of ports) if (sites[origin]?.trade) { try { port.postMessage({ event: 'tradeAccountChanged', data: after?.address ? tradeView(after) : null }); } catch {} }
});
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes['masked.public']) return;
  const before = changes['masked.public'].oldValue || {};
  const after = changes['masked.public'].newValue || {};
  const sites = await getSites();
  for (const { port, origin } of ports) {
    if (!sites[origin]) continue;
    try {
      if (before.address !== after.address) port.postMessage({ event: 'accountsChanged', data: after.address ? [after.address] : [] });
      if (before.net !== after.net) {
        port.postMessage({ event: 'networkChanged', data: NETS[after.net]?.unisat });
        port.postMessage({ event: 'chainChanged', data: chainInfo(after.net) });
      }
    } catch {}
  }
});

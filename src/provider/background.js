// MASKED background service worker.
// Owns: the list of connected sites, request routing, approval windows and dApp events.
// It never sees private keys. Anything that needs a key opens the wallet in an approval window,
// where the user approves or rejects and the wallet page does the signing.
import { NETS, chainInfo, err, makeHandler, tradeView } from '../dapp/requests.mjs';
import { RGB_PENDING, rgbWindowBounds } from '../app/Platform.mjs';

const _APPROVAL = new Set(['requestAccounts', 'signMessage', 'signPsbt', 'signPsbts', 'sendBitcoin', 'switchNetwork', 'switchChain', 'inscribeTransfer', 'getTradeAccount', 'fundTradeAccount', 'moveToTradeAccount', 'returnToShielded', 'cashuPay', 'cashuPayRequest', 'cashuReceive', 'rgbRequestInvoice', 'rgbPayInvoice', 'rgbSwapAvailable', 'rgbListAssets', 'rgbOutputs', 'rgbFreeSpare', 'rgbBuyPrepare', 'rgbSalePrepare', 'rgbBuySign', 'rgbSaleComplete', 'rgbInstantList', 'rgbInstantListLots', 'rgbInstantBuy', 'rgbInstantBuyMany', 'rgbInstantCancel']);

const pending = new Map(); // id -> { origin, method, params, resolve, reject, windowId }
const ports = new Set();   // { port, origin }

async function getPublic() { return (await chrome.storage.local.get('masked.public'))['masked.public'] || null; }
async function getTrade() { return (await chrome.storage.local.get('masked.trade'))['masked.trade'] || null; }
async function getSites() { return (await chrome.storage.local.get('masked.sites'))['masked.sites'] || {}; }
async function setSites(s) { await chrome.storage.local.set({ 'masked.sites': s }); }

// Approvals open in MASKED's own toolbar popup (like other wallets). If Chrome cannot open it
// (older Chrome, no focused window), a small popup window is used instead.
const POPUP = 'masked.html?popup=1';
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
// RGB servers allowed from the toolbar popup: Chrome's prompt closed the popup, so reopen MASKED at the same step.
// One approval in all: the reopened page already has the permission and carries on.
const popupOpen = async () => {
  if (!chrome.runtime.getContexts) return false;
  try { return (await chrome.runtime.getContexts({ contextTypes: ['POPUP'] })).length > 0; } catch { return false; }
};
chrome.permissions.onAdded.addListener(async () => {
  await new Promise((r) => setTimeout(r, 400)); // a popup that stayed open clears the pending step itself
  let id = null;
  try { id = (await chrome.storage.session.get(RGB_PENDING))[RGB_PENDING]; } catch { return; }
  if (!id) return;
  await chrome.storage.session.remove(RGB_PENDING).catch(() => {});
  // the popup didn't close after all (it carries on by itself): never open a second MASKED
  if (await popupOpen()) return;
  const page = `masked.html?popup=1&rgbResume=${encodeURIComponent(id)}`;
  if (chrome.action?.openPopup && ![...pending.values()].some((p) => p.mode === 'popup')) {
    try {
      await chrome.action.setPopup({ popup: page });
      await Promise.race([chrome.action.openPopup(), new Promise((_, no) => setTimeout(() => no(new Error('popup timeout')), 1500))]);
      // any open popup counts: the page drops ?rgbResume from its address as soon as it has read it
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (await popupOpen()) return void resetPopup();
      }
    } catch { /* no focused browser window: a small window instead */ }
    await resetPopup();
    if (await popupOpen()) return;
  }
  const url = chrome.runtime.getURL(page);
  const browser = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const bounds = rgbWindowBounds(browser);
  await chrome.windows.create({ url, type: 'popup', focused: true, ...bounds })
    .catch(() => chrome.windows.create({ url, type: 'popup', focused: true, width: bounds.width, height: bounds.height }))
    .catch(() => {});
});
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


// every site request is checked and answered in ../dapp/requests.mjs (shared with the phone app's in-app market)
/** The RGB token list MASKED last saw for this network and account (RAM only, written by the wallet's windows). */
async function getRgbShare(net, address) {
  try { const all = (await chrome.storage.session.get('masked.rgb.share'))['masked.rgb.share'] || {}; return all[`${net}:${address}`] || null; } catch { return null; }
}
const handle = makeHandler({ getPublic, getTrade, getSites, setSites, openApproval, emitTo, getRgbShare });

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


// "Sell automatically" (2.25.1-2.27.1) was removed: Instant listings sell while the seller is offline. Forget what it
// left: its settings and offer list, and the RGB key it kept in Chrome's session memory.
chrome.runtime.onInstalled?.addListener(() => {
  chrome.storage.local.remove(['masked.autosell', 'masked.autosell.on']).catch(() => {});
  chrome.storage.session?.remove('masked.rgb.agentPass').catch(() => {});
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
});

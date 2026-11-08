// The automatic-sale helper: a hidden extension page (chrome.offscreen) the background opens for one step of a sale
// the person set to sell automatically, then closes. It opens the RGB wallet with the key the wallet left in Chrome's
// session memory, runs the same checks as an approved sale, and closes the wallet again.
//
// It only ever does two things, and only for an offer the person approved for automatic selling, with the exact
// token, amount and price they approved: prepare the sale for a buyer (prepareSale), and send it once the buyer
// has signed (completeSale).
import { RGB_MAINNET, profileOf } from './config.mjs';
import { RgbCloud, cloudKeysFrom, seal } from './cloud.mjs';
import { changedTerms, readOffer } from './swap.mjs';

/** @typedef {{ profile: string, key: string, cloud?: string, cloudOn?: boolean, indexers?: string[] }} AgentPass */

const profileFor = (id, indexers) => {
  const p = id === 'mainnet' ? RGB_MAINNET : profileOf(id);
  const urls = (indexers || []).filter((u) => /^https:\/\//.test(u));
  return urls.length ? { ...p, sdk: { ...p.sdk, indexerUrls: urls } } : p;
};

/** Back the RGB wallet up to the cloud after a sale (mainnet, cloud backup on). A failure leaves it for the wallet. */
async function cloudBackup(service, pass) {
  if (pass.profile !== 'mainnet' || !pass.cloudOn || !pass.cloud) return false;
  const keys = await cloudKeysFrom(pass.cloud);
  const vkey = `${RGB_MAINNET.vaultKey}.cloud-version`;
  const version = (Number(localStorage.getItem(vkey)) || 0) + 1;
  await new RgbCloud().put(keys.id, await seal(keys, await service.backup(), version));
  localStorage.setItem(vkey, String(version));
  localStorage.setItem(`${RGB_MAINNET.vaultKey}.cloud-at`, String(Date.now()));
  service.backupSaved();
  return true;
}

/**
 * One step. `entry` is what the person approved; `offer` is what the market says now.
 * @param {{ step: 'sale'|'complete', entry: any, offer: any, pass: AgentPass }} job
 */
export async function runStep({ step, entry, offer, pass }, { locks = navigator.locks, runtime = null } = {}) {
  if (!pass?.key) throw new Error('LOCKED');
  // the exact terms the person approved, nothing else
  const now = readOffer(offer.offer, offer.id);
  if (changedTerms(entry.terms, now)) throw new Error('The offer changed after you set it to sell automatically.');
  return locks.request(`masked-rgb-${pass.profile}-v1`, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('BUSY'); // RGB is open in a MASKED window: that window finishes it
    const rt = runtime || await import(new URL('rgb-runtime.mjs', location.href).href);
    const service = new rt.SignetWallet({ loadSdk: rt.loadRgbSdk, storage: localStorage, profile: profileFor(pass.profile, pass.indexers) });
    if (!service.exists) throw new Error('No RGB wallet in this browser.');
    await service.open(pass.key, () => { throw new Error('No RGB wallet in this browser.'); });
    try {
      let result;
      if (step === 'sale') {
        if (offer.state !== 'MATCHED' || !offer.session) throw new Error('No buyer waiting.');
        result = await service.prepareSale({ offerId: offer.id, network: offer.network, session: offer.session, offer: offer.offer });
      } else if (step === 'complete') {
        if (offer.state !== 'SIGNED' || !offer.signedPsbt) throw new Error('The buyer has not signed.');
        result = await service.completeSale({ offerId: offer.id, psbt: offer.signedPsbt, offer: offer.offer });
      } else throw new Error('Unknown step.');
      await cloudBackup(service, pass).catch(() => false);
      return result;
    } finally { await service.close().catch(() => {}); }
  });
}

// the page itself: answer the background, one step at a time
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && typeof document !== 'undefined') {
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.target !== 'masked-rgb-agent' || sender.id !== chrome.runtime.id) return undefined;
    runStep(msg.job).then((result) => reply({ ok: true, result }), (e) => reply({ ok: false, error: String(e?.message || e) }));
    return true;
  });
}

// MASKED content script — isolated world bridge between the page (window.masked) and the extension.
// It forwards only well-formed requests from the same window and tags them with the real origin
// (the extension, not the page, decides who is asking).
(() => {
  const TARGET_IN = 'masked-inpage';
  let port = null;
  const inflight = new Set();
  let ping = null;

  function connect() {
    port = chrome.runtime.connect({ name: 'masked-rpc' });
    port.onMessage.addListener((msg) => {
      if (msg.event) {
        window.postMessage({ target: TARGET_IN, event: msg.event, data: msg.data }, window.location.origin);
        return;
      }
      inflight.delete(msg.id);
      if (!inflight.size) { clearInterval(ping); ping = null; }
      window.postMessage({ target: TARGET_IN, id: msg.id, result: msg.result, error: msg.error }, window.location.origin);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // read it so Chrome doesn't log "Unchecked runtime.lastError" (e.g. page moved to back/forward cache)
      port = null;
      clearInterval(ping); ping = null;
      // anything still waiting has lost its reply channel
      for (const id of inflight) window.postMessage({ target: TARGET_IN, id, error: { code: 4900, message: 'MASKED disconnected. Please retry.' } }, window.location.origin);
      inflight.clear();
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.target !== 'masked-content') return;
    const { id, method, params } = e.data;
    if (typeof id !== 'string' || typeof method !== 'string') return;
    if (!port) connect();
    inflight.add(id);
    // keep the service worker awake while an approval window is open
    if (!ping) ping = setInterval(() => { try { port?.postMessage({ ping: true }); } catch {} }, 20000);
    port.postMessage({ id, method, params });
  });

  // subscribe early so events reach pages that are already connected
  try { connect(); port.postMessage({ hello: true }); } catch {}
  // back/forward cache: Chrome closes the port when the page is cached, so close it ourselves and reconnect on return
  window.addEventListener('pagehide', (e) => { if (e.persisted && port) { try { port.disconnect(); } catch {} port = null; } });
  window.addEventListener('pageshow', (e) => { if (e.persisted && !port) { try { connect(); port.postMessage({ hello: true }); } catch {} } });
})();

// Copy text to the clipboard. navigator.clipboard is refused in some places: the Android app's WebView (older ones
// especially), pages without focus. Then the text goes through a hidden text box and the browser's copy command,
// which Android WebView supports. Returns whether it worked.

/** @param {string} text @param {Document} [doc] */
export async function copyText(text, doc = globalThis.document) {
  try {
    if (globalThis.navigator?.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* next way */ }
  return copyWithCommand(text, doc);
}

/** @param {string} text @param {Document} [doc] */
export function copyWithCommand(text, doc = globalThis.document) {
  if (!doc?.body || typeof doc.execCommand !== 'function') return false;
  const box = doc.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  // off screen, but selectable (display:none can't be copied); no zoom on phones (16px)
  box.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;font-size:16px;';
  doc.body.append(box);
  const active = doc.activeElement;
  try {
    box.focus();
    box.select();
    box.setSelectionRange(0, text.length);
    return doc.execCommand('copy');
  } catch { return false; } finally {
    box.remove();
    /** @type {HTMLElement | null} */ (active)?.focus?.();
  }
}

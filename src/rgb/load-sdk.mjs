// Load only packaged resources. Four chunks keep the generated binary artifacts manageable.
let loaded;
export function loadRgbSdk() {
  if (!loaded) loaded = (async () => {
    const sdk = await import('@utexo/rgb-sdk-web');
    const { default: init } = await import('@utexo/rln-wasm');
    const parts = [];
    for (let i = 0; i < 4; i++) {
      const response = await fetch(new URL(`./rln-wasm-${i}.bin`, import.meta.url));
      if (!response.ok) throw new Error('Packaged RGB runtime is missing. Rebuild the extension.');
      parts.push(new Uint8Array(await response.arrayBuffer()));
    }
    const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    await init({ module_or_path: bytes });
    return sdk;
  })().catch(error => { loaded = null; throw error; });
  return loaded;
}

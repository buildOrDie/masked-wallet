// Large RGB backups exceed the argument limit of String.fromCharCode(...allBytes).
export function b64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
export const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

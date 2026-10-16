// Ambient types for the type check (npm run typecheck). The code is plain JavaScript with JSDoc.
declare module '*.wasm' { const bytes: Uint8Array; export default bytes; }
declare const chrome: any;
interface Window { Capacitor: any }

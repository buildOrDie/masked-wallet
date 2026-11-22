**Faster Instant buys and listings**
- An Instant buy no longer waits for a full wallet sync: it pays from coins it already knows, checked on the chain at once, and finishes as soon as the purchase is sent.
- Several listings bought together go in one transaction even when your RGB balance has a single bitcoin coin.
- Listing checks your token outputs 8 at a time; fetched transactions are kept a month, so far fewer requests to the block server.

**Wallet-to-wallet trades (from 2.31.0)**: MASKED speaks UniSat Wallet's P2P swap flow, so markets can let MASKED and UniSat users trade RGB tokens with each other. Testing on Signet. MASKED is independent and not affiliated with UniSat.

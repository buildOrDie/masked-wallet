# Shielded Ordinals integration

MASKED's Settings includes a **Shielded Ordinals (SHORD)** collection status monitor. It works without
a local Bitcoin node. It is an initial read-only integration, not a SHORD account or a light verifier.
The existing Shielded balance is BIP 352 silent payments; it is not a balance of SHORD notes.

## Use the monitor

1. Open Settings on the desired network.
2. Enter a SHORD indexer base URL and, optionally, a second independently operated indexer.
3. Set the collection's parent inscription ID. The field initially contains Shielded Nakas on mainnet;
   on Signet, replace it with the parent of a Signet collection your indexer follows.
4. Press **Save & check** and grant access to the selected server origins in Chrome.
5. Press **Check again** for a new snapshot, or **Turn off** to remove the configuration.

The upstream public mainnet indexer is `https://shielded-public-api-production.up.railway.app`.
Its status route is public. No API key is embedded, requested or stored. Any compatible indexer
serving `/c/<cid>/status` works, including `http://127.0.0.1:5021`. Remote servers must use HTTPS.
Browser deployments also need the indexer's CORS support.

No SHORD requests are made on startup or in the background. Checks request only the collection
status and the Bitcoin block hash at its reported height. They never send wallet addresses, notes,
view keys, spend keys or the recovery phrase. Servers still see the caller's IP and collection interest.
Configuration is saved per network; reports stay in memory and are cleared when switching networks.
Turning off prevents in-flight responses from repopulating the report; requests already sent may finish.

## What the checks establish

- The collection ID is derived locally from the parent inscription ID using SHORD's SHA-256 recipe.
- Status responses must match that parent, collection ID and network, with valid typed height,
  block hash, note count and digest fields.
- When both indexers report the same height, their block hashes, summary digests and note counts
  are compared. Different heights are inconclusive, not agreement. Use different operators;
  different URLs do not guarantee independence.
- The primary's block hash is compared with the answer from MASKED's configured Bitcoin API pool.
  An unavailable API is not a successful check. An explicit mismatch is displayed as a conflict.

These are corroboration checks, not consensus or ownership verification. A malicious indexer can
report a real block hash alongside fabricated state. Multiple indexers can collude. The upstream
summary digest omits encrypted note data and several listing fields. There is no local proof of
complete history, chainwork, difficulty transitions, mint authorization or valid SHORD transitions.
Snapshots do not assert that an indexer is caught up with the tip.

## Path to a usable independent SHORD wallet

Keep the following work separate from this monitor:

1. **Protocol-compatible account and scanner:** implement/test seed derivation, Poseidon commitments,
   x25519/ChaCha20-Poly1305 note decryption, nullifiers, Merkle paths, local note scanning and encrypted
   backup/restore. Keep SHORD secrets in the unlocked wallet page; never derive them from a website
   signature or expose them through the background or provider. Establish interoperability vectors
   with the upstream wallet before accepting funds. Do not invent an incompatible derivation scheme.
2. **Proofs and transaction flows:** obtain reproducible spend-circuit proving artifacts and confirm
   verification-key hashes. Bundle approved dependencies/assets locally, respecting the extension CSP.
   Build and test transfers, listings, buys and seller recovery on Signet with explicit approvals,
   coin protection, relay configuration and fee/payment checks. Upstream's public repository currently
   excludes the production wallet and transaction builders; its verification keys alone cannot prove.
3. **Independent verification:** validate a header chain with difficulty rules and cumulative work;
   authenticate full block transaction data, witness data and previous transactions; replay every
   protocol-relevant event, including listing-lock spends, in canonical order. Handle reorgs and
   authenticated checkpoints without treating an operator's snapshot hash as a validity proof.
4. **Proof-carrying state (research):** prove completeness and correct execution against authenticated
   Bitcoin data, and verify the proofs locally. This requires new proving infrastructure outside the
   wallet. A proof of transaction inclusion alone cannot establish that no relevant events were omitted.

Protocol-level changes (public trusted-setup ceremony, new collection rules and co-signer policy)
need upstream coordination. A wallet update cannot change existing collection rules or remove their
gate/lock signing dependencies. Do not offer ordinary inscription shielding: it is not implemented
by the upstream SHORD v1 protocol.

References: [upstream protocol](https://github.com/Fl1ntstowned/shielded-ordinals/blob/main/PROTOCOL-v1.md),
[API](https://github.com/Fl1ntstowned/shielded-ordinals/blob/main/docs/API.md),
[status and trust assumptions](https://github.com/Fl1ntstowned/shielded-ordinals/blob/main/docs/STATUS.md).

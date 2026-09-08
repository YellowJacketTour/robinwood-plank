# Akasha

Push-first multi-chain NFT archive. One writer owns the tip. Everything else is a projection.

This tree is the four inventions as running code, with the three corrections pinned by test:

1. Crowd-hydrate of “two visitor hashes” is dead. Viewport nonce + self-authenticating objects vs observations.
2. There is no chain subscription in a typical stack today — `hose` is that process. Discovery is topic-only; the two address-scoped helpers are genesis work, not discovery.
3. Floors are claim kits. A bare number is a ship-blocker.
4. OpenSea Stream cannot create artifacts.

## Processes

```
hose          — only writer of cursor, header, event, artifact, coverage, gap
cluster       — announcement graph over the tape (hard edges = identity)
hydrate       — visitor courier protocol
claims        — kits a stranger can recompute
```

Do not start `hose` as a second writer against tables another process already mutates. Cut over: stop the old discovery cursor, boot hose at that height as `t0`, then let projections catch up.

## Invariants

- `[t0, finalized]` is one coverage run or the stream is not alive.
- Events delete by `block_hash`, never by height.
- Gap reasons: `reconnect | reorg | bloom_audit | seq_gap | attention_history`.
- `attention_history` requires an artifact that already exists.
- Exactly two address-scoped functions: `findEarliestTransferBlock`, `runAddressScopedMembershipScan`.

## Run

```
npm install
npm test
npm run lint:discovery
```

Booting against live endpoints is configuration, not a vendor SDK:

```
HOSE_ETH_RPC=https://... npm run hose
```

Bitcoin needs a local `bitcoind` with ZMQ/`sequence`. Public ordinal APIs are not a completeness path.

## What this does not claim

HTTPS `tokenURI` has no single body. Venue-held Bitcoin asks are not on-chain. Eleven chains of history do not fit a completeness walk on one host. Forward omniscience is the hose. Retrospective omniscience is attention-completed tape plus kits for whatever you display.

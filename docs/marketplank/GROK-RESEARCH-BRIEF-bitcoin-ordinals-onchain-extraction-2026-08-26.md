# Research brief for Grok: real, free, on-chain-only Bitcoin Ordinals extraction — the one chain family still missing this app's "identifying hash first, free source second" pattern

Status: **research + invention brief, narrowly scoped.** Written by Sonnet 5,
2026-08-26. This is deliberately NOT a repeat of the broader "unified
architecture" brief answered earlier today
(`GROK-FINDINGS-unified-maximal-hydration-2026-08-26.md`) — that response,
and this app's own prior work, already answered the general question this
brief's owner asked next ("do we scrape only identifying hashes and then
pull the rest from free corroborating sources like IPFS?"). The honest
finding, checked directly before writing this brief:

## What's already real and already built (don't re-research this)

This app already has the exact pattern being asked about, for its two
largest chain families:

- **EVM**: `lib/market/multichain/discovery/evm-token-metadata.ts`'s
  `resolveEvmTokenMetadata` reads `tokenURI()`/`uri()` DIRECTLY on-chain via
  a free public RPC `eth_call` (no vendor indexer), decodes the ABI string,
  and resolves the result through `lib/ipfs.ts`'s `IPFS_GATEWAYS` — FIVE
  real, free, public IPFS gateways (Pinata, ipfs.io, dweb.link,
  cloudflare-ipfs, one more) with fallback. OpenSea's rate-limited API
  (`resolveOpenSeaTokenMetadata`) is called ONLY when this free path fails
  — see `rarity-index-runner.ts` lines ~305-350, real fallback order,
  already live.
- **Solana**: `lib/market/multichain/discovery/solana-metaplex-reads.ts`
  reads the Metaplex Token Metadata PDA directly via free public
  `getAccountInfo` RPC — no Helius DAS dependency at all for this data —
  hand-decoding the real Borsh struct layout (verified against
  `mpl-token-metadata`'s actual source).
- **A full audit already exists** covering exactly this question across
  every chain family in exhaustive, EIP/standard-cited detail:
  `docs/AUDIT-onchain-data-extraction-2026-08-24.md` (2026-08-24, one day
  before this brief). It already scoped ownerOf/balanceOf/Transfer-log
  scanning, ERC-2981 royalties, ERC-7572 contract metadata, Solana Master/
  Print Editions, and more — most marked "build next," a real backlog, not
  unknown territory.

**Do not re-derive any of the above.** If your research turns up the same
tokenURI/IPFS/Metaplex-PDA pattern this app already uses, say so and move
on — citing it as if it were a new finding would waste the owner's time.

## The one real, honestly-flagged, still-open gap

`docs/AUDIT-onchain-data-extraction-2026-08-24.md` section 2 (Bitcoin
Ordinals) already identified and honestly scoped this exact gap:

> "Inscription envelope (content-type, body) ... Yes — pure witness-script
> parsing ... **Nontrivial**: requires raw-tx + witness fetch then
> hand-rolled Bitcoin Script opcode parsing (no ABI-decoder equivalent for
> Bitcoin Script) ... build if Ordinals support is a real product
> requirement — the floor everything else depends on."

Today, this app's real Bitcoin Ordinals data (see
`lib/market/multichain/adapters/unisat-collections.ts`,
`ordinalswallet-ordinals.ts`, `ordiscan-*`) depends entirely on three
rate-limited/keyless-but-fragile third-party indexers (UniSat, Ordiscan,
Ordinals Wallet) for collection discovery, inscription content, and
listings — there is currently NO free, on-chain-only path for Bitcoin the
way `tokenURI()`+IPFS is for EVM or the Metaplex PDA is for Solana. This is
the one chain family where "scrape only an identifying hash, then
corroborate from a free source" has NOT been realized, and it's real,
scoped, honestly hard work — Bitcoin Script has no ABI, unlike EVM.

## What to research and invent (real, specific)

1. **Real, current, minimal-dependency Bitcoin RPC/Electrum access for raw
   transaction + witness data.** This app's `rpc-provider-pool.ts` already
   does a keyless public-node pool pattern for EVM (publicnode.com,
   drpc.org) — is there a real, current, free, publicly reachable Bitcoin
   full-node RPC or Electrum server equivalent (no paid Blockstream/
   QuickNode subscription) that can serve `getrawtransaction` with witness
   data at the query volume this app would need? Cite real, current, still-
   operating endpoints — Bitcoin public RPC availability changes over time,
   don't cite a stale list.
2. **A real, minimal, correct Bitcoin Script witness-envelope parser.**
   The `ord` reference implementation (github.com/ordinals/ord) is the
   real, canonical source of the envelope grammar (`OP_FALSE OP_IF <"ord">
   OP_1 <content-type> OP_0 <content...> OP_ENDIF` in a taproot
   script-path spend, per `docs.ordinals.com`). Research the REAL, current,
   exact opcode sequence and taproot script-path structure (not an
   approximation) well enough to specify a correct, minimal TypeScript
   parser — same "hand-roll the one real struct shape, no general-purpose
   dependency" discipline this app already used for the Solana Metaplex
   Borsh decoder (`solana-metaplex-reads.ts`'s own header explains exactly
   why it hand-rolled Borsh instead of adding a dependency).
3. **Parent/child and delegate inscriptions** (tag 3 / tag 11 per the
   ord spec) — real, current tag-field encoding, so extraction covers
   these alongside the base envelope in one pass rather than needing a
   second research round later.
3. **What genuinely still requires an indexer vs. what's a pure parse.**
   The existing audit already correctly separated these — confirm/refine:
   envelope content-type/body IS a pure parse (no history-walk needed).
   Sat-tracking/ordinal numbering and BRC-20 balance computation both
   require replaying the ENTIRE transfer history from genesis — the audit
   calls this "architecturally build an indexer," not a simple extraction.
   Research whether there's a real, current, free, already-computed source
   for JUST the sat-range/inscription-number question (e.g., does any
   free public API expose this without this app needing to build a full
   ordinal-numbering indexer itself) — if genuinely none exists free,
   confirm the audit's "note only, do not build" verdict rather than
   inventing false hope.
4. **Real collection/membership discovery without UniSat/Ordiscan.**
   The free envelope parser above answers "what is inscription X," not
   "which inscriptions belong to collection Y" — is there a real, free,
   on-chain-derivable collection-membership signal for Ordinals (e.g., a
   real, current, widely-adopted on-chain collection-marking convention
   analogous to Metaplex's `collection: Option<Collection>` verified flag,
   if one exists and is actually adopted) or is collection curation
   genuinely an off-chain-only concept for Ordinals that this app must
   keep getting from a real indexer regardless? An honest "no" here is a
   valid, valuable answer — don't invent an unadopted convention to sound
   more complete.

## Constraints (same as every brief in this series)

- Free-tier/keyless only, no new paid infrastructure.
- Real, never fabricated — every opcode sequence, endpoint, and tag-field
  number must be independently verifiable against `ord`'s own real source
  or `docs.ordinals.com`, not approximated.
- Postgres-only datastore if any new persistence is needed.
- Real TypeScript for the parser, not pseudocode — written to slot into
  this app's real conventions (`lib/market/multichain/adapters/` or a new
  `bitcoin-onchain-reads.ts` alongside `onchain-contract-reads.ts`'s own
  EVM equivalent).

## Deliverable

1. Real citations, adopt/adapt/synthesize labels per this series' own
   discipline.
2. A real, minimal, correct witness-envelope parser (content-type + body +
   parent/child/delegate tags) as actual TypeScript.
3. An honest, specific verdict on collection-membership discovery: real
   free path found, or confirmed genuinely not free/on-chain-derivable
   today.
4. If a real, currently-operating free Bitcoin RPC/Electrum pool worth
   using is found, name it with a real citation (not a guess) so this app
   can build the same `rpc-provider-pool.ts`-style keyless pool for
   Bitcoin that already exists for EVM.

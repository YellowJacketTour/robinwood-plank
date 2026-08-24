# On-Chain Data Extraction Audit — RobinWood/Marketplank Multichain

**Date:** 2026-08-24
**Scope:** everything extractable via direct RPC/full-node reads (contract state calls + event log scans), zero vendor/indexer APIs, across EVM (8 chains + Robinhood Chain), Bitcoin Ordinals, and Solana. Existing infra: `lib/market/multichain/discovery/rpc-provider-pool.ts` (keyless publicnode.com + drpc.org pool) and `onchain-contract-reads.ts` (ERC721 `name()`/`totalSupply()`/`tokenURI()` + tokenURI resolution).

---

## 1. EVM (Ethereum, Polygon, Arbitrum, Base, Optimism, BNB, Avalanche, zkSync, Robinhood Chain)

### 1.1 Core ERC721 (EIP-721, Final)
| Data point | Method/signature | Notes | Priority |
|---|---|---|---|
| Collection name | `name() view returns (string)` | Already implemented | done |
| Token count | `totalSupply()` — **not part of base EIP-721**, only guaranteed by `ERC721Enumerable` | Base spec has no supply getter; many contracts expose it as custom, so current code works empirically but isn't spec-guaranteed | done, note caveat |
| Token metadata pointer | `tokenURI(uint256) view returns (string)` | Already implemented, resolves data:/ipfs://https:// | done |
| Current owner | `ownerOf(uint256) view returns (address)` | Single biggest missing primitive — "who owns this NFT right now" with no indexer | **build next** |
| Wallet's NFT count in collection | `balanceOf(address) view returns (uint256)` | Cheap portfolio-count check | build next |
| Approvals | `getApproved(uint256)`, `isApprovedForAll(address,address)` | Needed to show/validate listing approval state before a marketplace tx | build next |
| Capability detection | `supportsInterface(bytes4)` (ERC-165, Final) | Gate for every optional extension below — check once per contract, cache | build next, foundational |

### 1.2 ERC1155 (EIP-1155, Final)
| Data point | Method | Notes | Priority |
|---|---|---|---|
| Owned quantity (per id) | `balanceOf(address,uint256)` | Semi-fungible edition count | build next |
| Batch balances | `balanceOfBatch(address[],uint256[])` | One RPC call for many (owner,id) pairs — big efficiency win | build next |
| Metadata pointer | `uri(uint256)` — `{id}` placeholder substitution (hex, 64-char zero-padded) is spec-mandated, distinct from ERC721's `tokenURI` | Needs its own resolver path | build next |
| Approvals | `isApprovedForAll` (shared with 721) | — | build next |

### 1.3 Royalties — ERC-2981 (Final)
`royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address receiver, uint256 royaltyAmount)`. Fully on-chain, detected via `supportsInterface(0x2a55205a)`. Answers "who gets paid and how much" for checkout — **high priority**, checkout correctness depends on it, zero off-chain trust required.

### 1.4 Collection-level metadata — ERC-7572 (`contractURI()`)
Finalized EIP (OpenSea-authored, Dec 2023). `contractURI() view returns (string)` — same on-chain-pointer pattern as `tokenURI` (data:/ipfs://https://) but for the *collection*: name, description, banner/featured image, external_link. Also defines `event ContractURIUpdated()`. Has been a de-facto OpenSea convention for years pre-EIP, so many contracts implement it without declaring via ERC-165 — worth an opportunistic try-call even absent interface detection. Only fully on-chain path to a collection banner image. **Build next.**

### 1.5 On-chain enumeration — ERC721Enumerable
`tokenByIndex`, `tokenOfOwnerByIndex` (interfaceId `0x780e9d63`) — full trustless enumeration of every token ID, no indexer. Caveat: increasingly rare in gas-optimized/ERC721A-style contracts, gas-heavy over RPC (N calls). **Medium priority** — supplement to log-derived ownership, not a replacement.

### 1.6 Event-log-derived data (the real workhorse — no interface support needed)
All derivable from `eth_getLogs` against standard Transfer/Approval topics every ERC721/1155 contract MUST emit.

- **`Transfer(from, to, tokenId)`** (ERC-721): full provenance; current holder = last Transfer's `to` (cheaper than N `ownerOf` calls at scale); mint = `from==0x0`; burn = `to==0x0`.
- **`TransferSingle`/`TransferBatch`** (ERC-1155): same for semi-fungibles + operator attribution.
- **`Approval`/`ApprovalForAll`**: blanket-approval phishing indicator — real security signal.
- **Holder distribution**: aggregate current `to` per tokenId → concentration, unique-holder count.
- **Wash-trading heuristic**: repeated A→B→A transfer pairs in a short window, paired with fill events at round-trip prices — a heuristic, not a certainty.
- **Mint-order / "OG mint"**: `from==0x0` events ordered by block number.

**Priority: build next.** Highest-leverage item in the audit — one paginated `eth_getLogs` scan replaces what would otherwise need an indexer for ownership, provenance, and holder analytics at once.

### 1.7 Real sale price / marketplace fill events
- **Seaport `OrderFulfilled`** (MIT-licensed, `ProjectOpenSea/seaport`): `consideration` carries all payment legs (buyer payment + fee + royalty split) — decoding it fully reconstructs realized sale price, currency, fee breakdown, purely from logs. Deployed at the same canonical address across most of these 8 chains. **High priority.**
- Other marketplaces (Blur, LooksRare, X2Y2) have their own fill ABIs — real but bespoke per venue. **Lower priority / incremental.**

### 1.8 Dynamic-metadata & advanced-standard detection via ERC-165
- **ERC-4906 (Final)**: `MetadataUpdate`/`BatchMetadataUpdate` events (`supportsInterface(0x49064906)`) — signals cache invalidation for dynamic NFTs. **Build next**, cheap.
- **ERC-6551 (Final)**: token-bound accounts. Detected via the canonical Registry contract's `account()`/`AccountCreated` event, not `supportsInterface` on the NFT itself. Relevant since a "wallet" might be a TBA owned by an NFT — true ownership needs one more hop. **Medium priority.**
- **delegate.cash `DelegateRegistry`**: not an EIP but widely-adopted, immutable, canonical-address registry distinguishing holder vs. controller (cold-wallet delegating trading rights to a hot wallet). **Medium priority**, mainly airdrop/allowlist-adjacent.
- **ERC-5006/5501** (rental/delegation extensions): requires the NFT contract itself to implement it, rare/collection-specific. **Low priority / note only.**

### 1.9 On-chain generative/fully-rendered art heuristics
No formal EIP — pattern-matching only: large deployed bytecode (`eth_getCode` length) on the contract or an auxiliary renderer; SSTORE2 storage pattern (bytecode-as-data-blob, `EXTCODECOPY` read); `data:application/json;base64` tokenURI with embedded `data:image/svg+xml` (already partially handled). Useful provenance/permanence classification tag ("this art can never disappear") for a subset of prestige collections. **Low/medium priority.**

---

## 2. Bitcoin Ordinals

Source of truth: the `ord` reference implementation and Ordinal Theory Handbook (docs.ordinals.com, Casey Rodarmor) — a convention layered on raw Bitcoin consensus data, not a protocol change, so derivable from any full node/Electrum server exposing raw transactions and witness data, with real caveats.

| Data point | Source | On-chain-derivable? | Tooling gap | Priority |
|---|---|---|---|---|
| Inscription envelope (content-type, body) | Witness script: `OP_FALSE OP_IF <"ord"> OP_1 <content-type> OP_0 <content...> OP_ENDIF` in a taproot script-path spend | Yes — pure witness-script parsing | **Nontrivial**: requires raw-tx + witness fetch then hand-rolled Bitcoin Script opcode parsing (no ABI-decoder equivalent for Bitcoin Script) | **build if Ordinals support is a real product requirement** — the floor everything else depends on |
| Sat-tracking / ordinal number | Deterministic FIFO function over the full UTXO transfer history back to coinbase | Yes in principle, but requires walking the **entire transaction graph** back to origin, computing sat ranges at each hop — exactly what ord's own indexer does | **Large gap**: architecturally "build an indexer," not "make an RPC call" | lower priority — flag as known limitation unless sat-rarity display is a hard requirement |
| Parent/child, delegate inscriptions | Tagged fields (`parent`=tag 3, `delegate`=tag 11) pointing to another inscription ID | Yes, once envelope parsing exists | Same prerequisite, no extra graph-walk | medium — cheap add-on |
| Recursive inscriptions (`/content/<id>`) | Content body references another inscription ID, resolved at render time | Yes — plain string content | Application-layer rendering concern | low/medium |
| Cursed inscriptions / negative numbering | ord-indexer-assigned classification for envelope-rule violations | Only meaningful relative to ord's own historical rule-set/version logic | Requires replicating ord's specific rule history, not generic parsing | **note only, do not build** — indexer-implementation-defined, not a stable on-chain fact |
| BRC-20 / envelope-based fungible tokens | JSON content body (`{"p":"brc-20",...}`) inside an ordinary envelope; balances computed by replaying every valid inscription in order | Yes for parsing, but balances require the same ordering-replay problem as sat-tracking | Effectively reimplementing a BRC-20 indexer | **note only** — not needed unless product scope explicitly adds BRC-20 |
| Reveal vs. commit tx, fee/timing | Two-tx pattern (commit funds taproot output, reveal spends it revealing the envelope); standard `getrawtransaction`/`blocktime` fields | Yes, straightforward | Minor: identify commit ancestor of a reveal tx | low priority, cosmetic |

**Honest summary**: envelope/content parsing is a real, scoped engineering task on top of `rpc-provider-pool.ts`-style keyless Bitcoin RPC/Electrum access, requiring a from-scratch raw Bitcoin Script witness parser. Sat-tracking and BRC-20 balances are a different order of difficulty — architecturally "build a minimal indexer." Recommend envelope-content extraction as a realistic near-term build; sat-theory/BRC-20 explicitly out of scope until the product needs them.

---

## 3. Solana

Source: Metaplex's developer docs (`developers.metaplex.com/token-metadata`, `/core`) — the de facto standard by adoption (no EIP-equivalent numbered standard).

| Data point | Source | Detail | Priority |
|---|---|---|---|
| Metadata PDA — name/symbol/uri | Token Metadata program, PDA derived from `['metadata', program_id, mint]` | Fixed-size fields (name ≤32B, symbol ≤10B, uri ≤200B — same off-chain-JSON-pointer pattern as `tokenURI`/`contractURI`) | **build next** — Solana's direct equivalent of the EVM reads already built |
| Royalty bps | `seller_fee_basis_points` in the same Metadata account | Simpler than ERC-2981 — single bps value, no extra call | build next |
| Creators array + verified flags | `creators: Vec<Creator>` with `address`, `verified`, `share` | `verified==true` means that creator actually co-signed the mint — real cryptographic signal | build next |
| Collection field + verified flag | `collection: Option<Collection>` with `{verified, key}` | "Certified Collections" trust mechanism — `verified:true` means the collection's update authority signed a `VerifyCollection` instruction, a genuine on-chain trust signal distinct from off-chain curation claims | **build next, high value** |
| Uses/edition data | `uses: Option<Uses>` | Consumable/usable NFTs (game items, tickets) | low priority |
| Master/Print Edition | Separate PDA (`['metadata', program_id, mint, 'edition']`); `max_supply==0/None` = true 1/1; Print editions reference their Master + edition number | Direct on-chain 1/1-vs-limited-edition distinction, "edition N of M" | medium/high priority |
| Metaplex Core (newer standard) | Single unified Asset account (mint+metadata+token account collapsed, "plugins" for royalty/freeze/attributes) | Structurally simpler (one fetch vs. three) but a **different deserialization schema** — legacy-Token-Metadata code won't parse Core assets | build alongside legacy reader — Core adoption growing (cheaper to mint) |
| Holder / ownership | SPL Token program token account (`getTokenAccountsByOwner`/`getProgramAccounts` filtered by mint) — NOT on the Metadata account for legacy NFTs | Direct analogue of EVM `ownerOf`; Core collapses this into the Asset account itself | **build next** — without this there's no way to know who holds a legacy-standard Solana NFT |

**Honest tooling-gap note**: none of this is ABI-decodable like EVM — Solana account data is raw bytes requiring a **Borsh deserializer** built against Metaplex's specific struct layout (field order/sizes matter, unlike EVM's self-describing ABI). Real, different engineering investment from the EVM reader: hand-write the Borsh layouts (moderate, well-documented) or use a Metaplex-maintained SDK/IDL. Solana JSON-RPC (`getAccountInfo`, `getProgramAccounts`) itself is broadly available free/public, similar to the EVM pool already in use — the constraint is deserialization work, not endpoint access.

---

## 4. Priority Summary (build order)

1. **EVM**: `ownerOf`/`balanceOf`/approvals + `supportsInterface` gate.
2. **EVM**: Transfer/TransferSingle/TransferBatch log scanning — highest leverage item overall (provenance + holder distribution + mint detection + wash-trade heuristics from one mechanism).
3. **EVM**: ERC-7572 `contractURI()` — collection banner/description, same resolver pattern as existing `tokenURI` code.
4. **EVM**: ERC-2981 `royaltyInfo()` — checkout correctness.
5. **EVM**: Seaport `OrderFulfilled` log decode — real last-sale-price data.
6. **Solana**: Token Metadata PDA reader (name/symbol/uri/creators/collection/verified) + SPL token-account ownership lookup — Solana's parity baseline; new Borsh work, not EVM-code reuse.
7. **EVM**: ERC-4906 `MetadataUpdate` detection — cheap cache-invalidation fix.
8. **Solana**: Master/Print Edition + Metaplex Core reader — second Borsh schema.
9. **EVM**: ERC-6551 registry + delegate.cash registry reads — second-order ownership/control features.
10. **Bitcoin Ordinals**: raw envelope/content-type/content parser — substantial new witness-script-parsing subsystem, build only once Ordinals is a committed product surface.
11. **Note-only, do not build now**: on-chain generative-art bytecode heuristics, ERC-5006/5501 rental standard, Ordinals sat-theory/BRC-20 balance computation (indexer-project scale), cursed-inscription classification (indexer-implementation-defined).

### Sources
- [ERC-7572: Contract-level metadata via `contractURI()`](https://eips.ethereum.org/EIPS/eip-7572)
- [ERC-4906: EIP-721 Metadata Update Extension](https://eips.ethereum.org/EIPS/eip-4906)
- [ERC-6551: Non-fungible Token Bound Accounts](https://eips.ethereum.org/EIPS/eip-6551)
- [ERC-5501: Rental & Delegation NFT - EIP-721 Extension](https://eips.ethereum.org/EIPS/eip-5501)
- [Ordinal Theory Handbook — Overview](https://docs.ordinals.com/overview.html)
- [Ordinal Theory Handbook — FAQ](https://docs.ordinals.com/faq.html)
- [How Metaplex Metadata for Tokens Works | RareSkills](https://rareskills.io/post/metaplex-token-metadata)
- [Token Metadata Overview | Metaplex](https://developers.metaplex.com/token-metadata)
- [Verified Collections | Token Metadata](https://developers.metaplex.com/token-metadata/collections)
- [Differences between Core and Token Metadata | Metaplex](https://www.metaplex.com/docs/smart-contracts/core/tm-differences)
- [Decoding Seaport Events (OrderFulfilled) · ProjectOpenSea/seaport Discussion #546](https://github.com/ProjectOpenSea/seaport/discussions/546)
- [seaport/docs/SeaportDocumentation.md](https://github.com/ProjectOpenSea/seaport/blob/main/docs/SeaportDocumentation.md)

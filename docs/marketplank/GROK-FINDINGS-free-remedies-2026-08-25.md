# Grok findings: exhaustive free/rate-throttled remedies for blocked venues (2026-08-25)

Response to a follow-up ask after `GROK-FINDINGS-biggest-issues-unified-vision-2026-08-25.md`:
"exhaustive free / rate-throttled solutions for every remaining gap." Preserved
verbatim below. See the bottom for a synthesized recommendation, including two
items flagged as needing explicit owner sign-off before building, not a
default yes.

---

**Exhaustive free / rate-throttled solutions for every remaining gap**

Constraint box (honored throughout): no paid keys, no 1.5 TB OPI node, Postgres-only, fail-closed, never fabricate. "Unlimited" here means **no hard paywall**; public RPCs and free APIs still have soft rate limits — those are handled with your singleflight + Freshness Budget Controller pattern.

---

### 1. Tensor (live book / listings) — free on-chain account index

**Block:** gated GraphQL/REST.
**Already free:** settlement activity via program logs.

**Novel free path — List-State GPA Scanner (not in your registry yet)**

Tensor stores *active* listings in on-chain accounts (`SingleListing`, `ListState` / cNFT list state, pool accounts). These are ordinary Solana accounts. Public mainnet RPC supports `getProgramAccounts` with filters. Shyft and others already query the same accounts via paid GraphQL; the **accounts themselves are public**.

**Bespoke design:**

1. Maintain Tensor program IDs from `tensor-solana-trade.ts`.
2. Background job (cron or long-running under Passenger, throttled):
   - Rotate free public RPCs (Solana public, Helius free if present, community endpoints).
   - `getProgramAccounts` with dataSize / memcmp filters for listing account discriminators (from published Tensor IDLs / `@tensor-foundation` crates).
   - Decode `owner`, `nftMint` / `assetId`, `price` / `amount`, expiry.
3. Upsert into Postgres `tensor_onchain_listings(mint, price_lamports, owner, account, slot, fetched_at)`.
4. Collection floor = min(price) over mints you already track in that collection.
5. Label every number: `source: tensor_onchain_list_state`, `book: partial_gpa`.

**Rate strategy:** one GPA pass every N minutes per program; shard by collection whitelist you care about first; FBC widens interval under pressure. Free forever, completeness = "accounts visible on chosen RPC," not Tensor's off-chain index.

**What you get:** real list prices without API key.
**What you don't:** Tensor's ranked UI stats, hidden/private listings, or aggregator metadata.

**Confidence:** High that accounts are public; medium on exact current discriminators (verify once against live IDL / one known listing account).

---

### 2. Best in Slot — retired → replace with settlement + open listing fabrics

**Block:** API gone; OPI ruled out.

**Free stack (layered):**

| Layer | Free source | Role |
|-------|-------------|------|
| A | Confirmed inscription spends (mempool.space API + block filters) | Realized sales |
| B | UniSat free tier (you already have path) | Live book where UniSat has it |
| C | **Nostr ordinal listing events** (see below) | Decentralized open listings |
| D | Ordpool / mempool.space open-source parsers | Decode pending inscription txs |

**Novel: Nostr Ordinal Listing Aggregator**

Real prior art exists: marketplaces already publish listings to Nostr (kind ~30078 / custom listing kinds with inscription id, price, base64 PSBT).

**Bespoke Marketplank module:**

1. Subscribe to a small set of public relays (`wss://relay.damus.io`, `nos.lol`, etc.) filtered by tags `#i` (inscription id) or collection tags.
2. Validate: content looks like PSBT; optional BIP-322 / seller address consistency checks when cheap.
3. Store in Postgres as `source: nostr_listing`, never as "Best in Slot."
4. On spend of the inscription UTXO (from settlement scanner), mark listing dead.

**Rate:** WebSocket is free; throttle write volume; FBC on any REST fallback.

This does **not** resurrect Best in Slot. It replaces "one dead vendor" with **settlement truth + whatever open listings the network publishes**.

---

### 3. Ordzaar — no product to integrate

**Block:** launchpad / client SDKs, not an order book API.

**Solution:** registry status `coverage: "n/a_not_a_marketplace"`. Do not invent a feed. Secondary sales of Ordzaar-minted inscriptions appear via UniSat / on-chain settlement / Nostr like any other inscription.

Zero engineering beyond honest registry metadata.

---

### 4. Gamma Ordinals — no verified public API

**Block:** no documented free developer API; domain confusion with unrelated Gamma.

**Free alternatives:**

1. **Treat like any other PSBT venue:** settlement via inscription spends; listings only if they appear on UniSat or Nostr.
2. **Optional "public page probe" (fragile, last resort):** if `ordinals.gamma.io` or collection pages expose embedded `__NEXT_DATA__` / JSON, a throttled, robots-respecting fetcher *could* extract floors for *whitelisted collection URLs only*. This is brittle and ToS-sensitive — label `source: gamma_public_page`, fail closed on HTML change, never use for fulfillment. Prefer not to ship unless you accept maintenance cost.
3. **Direct outreach** remains the only path to a real API; until then, do not claim Gamma book coverage.

**Recommended:** settlement + UniSat overlap only; registry: `book: unavailable_no_public_api`.

---

### 5. OKX Ordinals — key-gated

**Block:** live API, no free tier; application pending.

**Free path (same pattern as Tensor settlements):**

- Do **not** wait on the key for *activity*.
- Confirmed OKX fills are Bitcoin txs; fee-address heuristics + inscription id movement give `source: onchain_settlement` (same pipeline as UniSat-settled trades).
- Listings: only what appears on free UniSat / Nostr / ORD.NET-if-funded.

When/if the OKX key arrives, add as opportunistic Layer C. Until then, product stays honest: "OKX settlements when seen on-chain; book not indexed."

---

### 6. ORD.NET — 0.01 BTC capital gate

**Block:** auth requires confirmed 0.01 BTC at challenge address (real capital, not a signup form).

**Free substitutes (no 0.01 BTC):**

| Approach | Cost | Yield |
|----------|------|--------|
| UniSat free API | $0 | Listings/sales they expose |
| Nostr listing aggregate | $0 | Open PSBT listings |
| Mempool.space free API | $0 | Pending + confirmed spends |
| Self-built PSBT offer board | $0 | Only offers *your users* post |

**Novel: Marketplank-native open PSBT board (bespoke)**

1. Authenticated users (or BIP-322 signed messages) POST a seller-signed PSBT + inscription id + price.
2. Server verifies signature binds the inscription UTXO (using existing bitcoin-utxo-safety patterns once live-tested).
3. Store as `source: marketplank_psbt_board`.
4. Anyone can complete the PSBT client-side; you never custody.
5. Invalidate on UTXO spend.

This is **your own free orderbook shard**, rate-limited by your app, not ORD.NET. It does not need their token. Optional later: if someone funds 0.01 BTC for ORD.NET, merge as another source with a source chip.

---

### 7. X2Y2 — marketplace dead

**Solution:** `coverage: "historical_only"`. Keep historical fills if you have them; no live book ever. Same pattern as any shut-down venue.

---

## Cross-cutting free architecture (invented for this app)

### A. **Settlement-First Universal Index (SFUI)**

One pipeline for *all* Bitcoin Ordinals venues you cannot book-read:

```text
mempool.space (free) + public block stream
    -> decode inscription-bearing spends
    -> attach known collection ids (from your UniSat/registry catalog)
    -> Postgres onchain_fills
    -> per-collection realized min/volume (labeled settlement, not floor)
```

Rate-throttled, unlimited in cost, honest.

### B. **Open Listing Fabric (OLF)**

Merge free listing surfaces only:

1. UniSat free key path (existing).
2. Nostr listing kinds (new).
3. Marketplank PSBT board (new).
4. Tensor GPA list accounts (new).
5. Never: fabricated or scraped pages unless explicitly labeled experimental.

Dedupe by inscription id / mint; cheapest valid price wins; each row carries `source[]`.

### C. **Optional Client Contribution Relay (CCR)** — radical, still free

Users who browse with a future lightweight extension or in-app opt-in can submit *signed* observations: "I loaded Tensor collection X and saw mint Y at Z SOL at time T." Server accepts only after:

- wallet signature,
- rate limit per wallet,
- statistical agreement with >=k independent reporters before promoting to "community_floor."

This is a **bespoke low-trust gossip layer**, not an oracle. Default off; never sole source for trade UI.

### D. **Registry-driven honesty**

Every blocked row becomes a structured status:

| Venue | Book | Activity | Free path |
|-------|------|----------|-----------|
| Tensor | GPA list accounts | Program logs | Yes |
| Best in Slot | None | Settlement + Nostr | Yes (partial) |
| Ordzaar | N/A | Settlement | N/A |
| Gamma | None verified | Settlement | Partial |
| OKX | Pending key | Settlement | Partial |
| ORD.NET | Capital gate | Settlement + OLF | Partial |
| X2Y2 | Dead | Historical | Historical |

UI chips consume this table so the unified shell never lies.

---

## Priority build order (all free)

1. **Tensor GPA listing scanner** — highest ROI missing book.
2. **Bitcoin SFUI settlement index** — covers BIS / Gamma / OKX / ORD.NET activity gaps.
3. **Nostr listing subscriber** — free open book shard.
4. **Marketplank PSBT board** — your own ORD.NET-shaped surface without 0.01 BTC.
5. Registry + inline source chips.
6. CCR only if you want long-shot community density.

---

## Explicit non-solutions (ruled out again)

- Self-host full OPI / 1.5 TB node.
- Paying Tensor / OKX / ORD.NET gates.
- Treating Ordzaar as a live order book.
- Silent HTML scraping of Gamma as production truth.
- Presenting settlement floors as live order-book floors.

---

**Bottom line:** Every gap either (a) has a free on-chain or open-protocol substitute, (b) is not a marketplace, or (c) is dead. The novel pieces worth inventing in *this* codebase are **Tensor list-state GPA indexing**, **Nostr+PSBT open listing fabric**, **settlement-first Bitcoin activity**, and **optional signed client contribution** — all rate-throttled, zero subscription cost, and compatible with fail-closed labeling so the unified vision stays credible instead of fake-complete.

---

## Synthesized recommendation (Sonnet 5, 2026-08-25)

Three of these are safe to build now with no new risk surface — same standard
as every other build this session (real, verifiable, discovery/read-only, no
fund custody):

1. **Tensor GPA listing scanner** — real public accounts, no key, no custody.
   Highest ROI (closes the actual live-book gap Tensor's off-chain API
   blocks). Build first.
2. **Bitcoin Settlement-First Universal Index (SFUI)** — mempool.space is a
   real, free, public API; this directly replaces the dead Best in Slot and
   fills the OKX/Gamma/ORD.NET activity gap with real on-chain truth.
3. **Nostr listing subscriber** — public relays, free, read-only, no custody.
   Real prior art (marketplaces already publish PSBT listings to Nostr) —
   worth verifying live that a real relay actually carries real Ordinals
   listing events before building the decoder, same "confirm before code"
   discipline as everything else, but the mechanism itself is sound.

**Two items need your explicit decision before any code, not a default yes:**

- **Gamma public-page probe.** Grok's own writeup calls this "brittle and
  ToS-sensitive" and "prefer not to ship unless you accept maintenance
  cost" — that's Grok flagging a real risk, not hedging. Scraping a site's
  rendered page data to extract prices is a materially different risk
  category than reading a public blockchain or a documented API, and belongs
  in the same bucket as the trading-canary decision: I can investigate
  whether it's technically feasible, but I won't build and ship a scraper
  against a third party's site without you saying so directly.
- **Marketplank-native PSBT offer board.** This is the one item on this list
  that moves from "read third-party data" into "custody-adjacent: verify and
  store a user's real signed PSBT that commits their real inscription."
  Grok's design keeps you non-custodial (anyone can complete the PSBT
  client-side, you never hold funds), but it still means shipping a new
  surface where a user's real Bitcoin asset is referenced by a signature
  this app verifies — and per the standing audit finding, `bitcoin-utxo-
  safety.ts` (which this would depend on) is itself still self-admittedly
  "not yet exercised/live-verified against a real inscription-bearing
  UTXO." Building this now would mean building a new feature on top of a
  foundation the audit already flagged as unproven. Recommend holding this
  one until that underlying safety module is actually verified, not
  bundling a new feature on an admittedly-shaky base.

**Not building, and not asking about:** the Client Contribution Relay (CCR).
Grok itself calls it "radical" and "never sole source" — it's a genuinely
interesting long-term idea but has no real urgency and a real design risk
(gameable community consensus) that deserves its own dedicated design pass,
not a rider on this batch.

Proceeding to build the three safe items now.

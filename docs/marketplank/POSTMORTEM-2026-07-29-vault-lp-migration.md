# Post-Mortem & Corrective Action Plan  
## Marketplank Vault Liquidity, Migration & Bootstrap (July 2026)

**Document type:** Formal incident analysis, resolution record, and ongoing development plan  
**Classification:** Internal product / engineering (shareable with partners after redaction review)  
**Date of record:** 2026-07-29  
**Status:** Resolved for primary technical blockers; follow-up controls in progress  

**Scope of this write-up:** Product, process, UX, and operational failures around Instant Swap vault liquidity (pool depth vs inventory), public LP add/remove, dual-vault migration, treasury bootstrap/seeding of a successor vault (V2), wallet connectivity on mobile, and site delivery.  

**Out of scope / deliberately omitted:** Private keys, seed phrases, API secrets, OAuth tokens, personal account identifiers, non-public infrastructure credentials, and exploit-oriented detail beyond what is required to prevent recurrence.

---

## 1. Executive summary

The Marketplank Instant Swap product correctly separated **inventory (deposited NFTs / share supply)** from **AMM pool depth (ETH reserve + shares held by the vault contract)**. That design is sound for solvency, but it created a **user-visible gap**: many depositors held shares in wallets while the public buy/sell book remained thin.  

The team introduced **public Add LP / Remove LP** (with per-address credits on the upgraded vault) and a **dual-vault migration path** so existing inventory would not be stranded when deploying a successor vault with full LP support. Delivery of that work was disrupted by a sequence of **client-side defects**, **wallet/network handling bugs**, **inventory cache poisoning**, **over-aggressive HTML caching**, **Cloudflare Free-tier operational limits**, and **bootstrap UX that blocked seed when secondary price data failed**.

**Resolution state (as of this record):**

| Item | State |
|------|--------|
| V1 vault (legacy inventory) | Live; retained for existing deposits |
| V2 vault (LP-capable) | Deployed, seeded (2 NFTs + ETH), ready to open / opened per operator decision |
| Dual-vault site config | Primary = V2, Legacy = V1 |
| Add/Remove LP on V2 bytecode | Present |
| Critical client bugs (chain id 18019 false positive, empty inventory cache) | Fixed and redeployed |
| Formal CAP (this document) | Active |

**Bottom line:** No evidence of vault insolvency or unauthorized drain of user NFTs during this incident. Primary harm was **operator and user friction**, **false error states**, **temporary inability to complete treasury seed/open**, and **risk of abandoning V1 without dual-vault discipline**. Liquidity on V1 pool ETH cannot be administratively moved to V2 by design; that is a documented property, not an accidental loss of depositor inventory.

---

## 2. Background: system model (non-compromising)

### 2.1 Two layers of the Instant Swap vault

1. **Inventory layer**  
   - User deposits NFT → mints vault shares (minus mint fee) to the user’s wallet.  
   - Redeem burns shares → returns an NFT (random or targeted).  
   - Invariant (simplified): outstanding shares (plus pending redeem accounting) are backed by held NFTs.

2. **AMM pool layer**  
   - Buy/sell trade ETH against **shares currently held by the vault address**.  
   - `ethReserve` tracks the ETH side of the book.  
   - Deposit alone does **not** place shares into the pool.

### 2.2 Why “57 held / ~5 pool shares” was correct math

Depositors sitting on wallet shares while the pool was thin was **expected behavior**, not a stuck-deposit bug on the happy path (Deposit button → mint shares). Confusion arose because UI and docs had not fully educated users, and there was no first-class “move my shares into the book / take them back” path on the first production vault.

### 2.3 Vault upgrade reality

The first production vault is **immutable** (no proxy). New LP accounting (`contributeLiquidity` / `removeLiquidity` with credits) required a **new deployment (V2)**. Safe migration therefore required:

- Keeping V1 address reachable for redeem/deposit, and  
- Pointing new activity at V2 only after dual configuration.

Treasury **seed** ETH on V1 has **no admin withdraw**; that is intentional anti-rug design. V2 must be seeded with **new** ETH.

---

## 3. Incident narrative (condensed)

### Phase A — Product gap recognized

- Operators and users needed a way to deepen the Instant Swap book without selling into it.  
- Response: design **Add LP / Remove LP** (one-way absolute credits, not Uniswap V2 LP tokens).  
- Live V1 lacked remove + ETH contribute; UI used share transfer as a legacy add path.

### Phase B — Dual vault & documentation

- Full `/learn` documentation expanded for humans and AI scrapers.  
- Dual-vault env: `PRIMARY` (new) + `LEGACY` (V1).  
- Migrate UI + Safe migrate walkthrough for holders (fees disclosed honestly).

### Phase C — V2 deploy & bootstrap

- V2 deployed via owner-controlled deploy tool (wallet-signed; no keys in chat).  
- Reused existing randomness beacon.  
- Site pointed primary → V2, legacy → V1.  
- Treasury bootstrap UI (image NFT picker + seed ETH + open pool) restored for closed primary vault.

### Phase D — Delivery failures (operator path)

While attempting to connect treasury, seed V2, and open:

1. **WalletConnect / Rabby**  
   - Extension-first connect frustrated mobile operators.  
   - QR flow added; AppKit modal failed under bundling → custom QR.  
   - Wrong-chain handling and re-scan freezes.  
   - **False “chain 18019” errors** while wallet was on Robinhood (4663).

2. **Chain ID parsing bug**  
   - `parseInt("4663", 16) === 18019`.  
   - WalletConnect path returned decimal chain id; site treated user as off-network.  
   - Same class of bug in a second code path after the first fix.

3. **Treasury bootstrap blocked on sales price**  
   - “Could not price the seed yet” blocked deposit+seed when average sale API returned empty.  
   - Operator could select NFTs but not complete seed/ETH pair.

4. **Inventory cache poisoning**  
   - Empty wallet bag cached as fresh → “no NFTs” while chain still showed ownership.  
   - On-chain check confirmed #329 and #1177 still in treasury until successful deposit.

5. **Site delivery**  
   - Cloudflare Free Worker size limit tripped when WalletConnect was bundled into the worker.  
   - Mitigated by static browser bundle.  
   - “Deployment temporarily paused” pages on some mobile edges (platform limit / pause), independent of app logic.  
   - Aggressive edge caching of HTML (`s-maxage` very large) delayed users from receiving fixes.

6. **Successful seed (pre-open)**  
   - On-chain verification later showed: held 2, pool shares 2, ethReserve 0.0088 ETH, pool closed, selectors for buy/sell/deposit/redeem/LP present, solvency consistent.  
   - Operator cleared to open pool when ready.

---

## 4. Formal analysis

### 4.1 What worked

- On-chain vault invariants held (shares vs held NFTs).  
- No admin ability to rug pool ETH (by design).  
- Dual-vault model prevented silent stranding of V1 depositors when V2 was introduced.  
- Deploy/seed paths remained wallet-signed (no secret key handling in assistant workflows).  
- On-chain readbacks used to verify seed before recommending open.

### 4.2 What failed

| Category | Failure | Impact |
|----------|---------|--------|
| Product education | Deposit vs pool depth poorly explained historically | User anxiety (“stuck deposits”) |
| Architecture constraint | Immutable V1 without LP withdraw | Forced dual vault + migration UX |
| Client correctness | Chain id radix bug (18019) | Blocked connect/seed with false error |
| Client reliability | WC disconnect/switch hangs | Frozen mobile connect loops |
| Client data | Empty inventory cache | Hidden treasury NFTs after partial ops |
| UX logic | Seed blocked on optional price oracle | Could not complete bootstrap |
| Delivery | Worker size / CF free limits / HTML cache | “Site down” / “paused” / stale bugs |
| Process | Many rapid fixes without cache-bust discipline | Operators saw old error strings after “fixes” |

### 4.3 Root causes (ranked)

1. **Insufficient separation of critical path from optional data**  
   Bootstrap seed depended on average sale price; optional analytics became a hard gate.

2. **Inadequate chain-id normalization across all wallet entry points**  
   Fixed in one place, left broken in WalletConnect soft-check path; incomplete test coverage for decimal vs hex chain ids.

3. **Inventory cache treated “empty” as authoritative**  
   Transient RPC/proxy failures or race conditions poisoned UX for hours (TTL + localStorage).

4. **Mobile wallet connectivity treated as an afterthought**  
   Extension-centric `connectWallet` assumed desktop injectors; WC added late under time pressure.

5. **Edge caching / Free-tier ops not part of release checklist**  
   Long `s-maxage` on HTML + frequent deploys → users on stale clients; CF free limits surfaced as “paused.”

6. **Documentation lag vs protocol reality**  
   Math was correct; narrative and LP tools lagged, driving emergency product work.

### 4.4 Impact assessment

| Stakeholder | Impact |
|-------------|--------|
| Existing V1 depositors | Inventory remained on V1; dual-vault keeps redeem path; no forced migration |
| Treasury / operators | High friction to seed V2; false network errors; delayed open |
| Market users | Thin V1 book confusion; temporary site access issues on some mobile clients |
| Security / funds | No identified loss of vault inventory due to these bugs; fees remain as designed |

### 4.5 Fee / migration honesty (resolution narrative)

Migration redeem → re-deposit charges **protocol fees already on-chain** (mint/redeem bps), not a hidden “migration tax.” Dust share shortfall after single-deposit redeem is a known fee interaction and must remain disclosed on `/learn` and migrate UI.

---

## 5. Resolution (what was done)

### 5.1 Product / protocol

- Implemented and documented **Add LP / Remove LP** with per-address credits on upgraded vault source.  
- Deployed **V2** with contribute/remove selectors; reused existing beacon.  
- Configured **dual vault**: primary V2, legacy V1.  
- Verified seed state on-chain before advising open.  
- Documented that V1 pool ETH cannot be administratively aggregated into V2.

### 5.2 Client fixes

- WalletConnect QR connect path (static asset bundle to respect Worker size limits).  
- Chain-id **normalizeChainId** + `isRobinhoodChainId` across send/connect paths.  
- Remove hard throw of false “chain 18019” from WC path; improve post-connect “continue after switch” UX.  
- Treasury bootstrap: **editable ETH**, fallback pricing, deposit-only + seed-unseeded actions.  
- Inventory: do not treat empty cache as fresh; force-refresh for treasury seed; “Reload NFTs from chain.”  
- Mobile WebView: splash timeout, skip splash in wallet UAs, audio preload none, skip art SW in wallet browsers.

### 5.3 Operations

- Multiple production redeploys after each critical fix.  
- On-chain verification scripts used for go/no-go on open.  
- This post-mortem and CAP established.

### 5.4 Open / residual items

| Item | Owner | Priority |
|------|-------|----------|
| Confirm V2 `openPool` executed and monitored | Operator | P0 if not yet open |
| HTML/document cache-control for app routes (short TTL) | Engineering | P0 |
| Automated tests for chain-id normalization | Engineering | P0 |
| Inventory cache unit tests (empty/non-empty) | Engineering | P1 |
| Bootstrap e2e against mock vault (deposit → seed → open) | Engineering | P1 |
| CF plan / limits monitoring & runbook | Ops | P1 |
| Holder communications for dual-vault / optional migrate | Product | P1 |
| Thin V2 book communication + optional further seed before or after open | Operator | P1 |
| Third-party audit of vault before large TVL | Security | P1/P2 |

---

## 6. Post-mortem (blameless)

### 6.1 What we will not do

- Blame individual operators for false “wrong network” or empty inventory.  
- Claim V1 pool ETH was “stolen”; it is non-withdrawable by design.  
- Force users to migrate under incomplete tooling.

### 6.2 What we will change (culture / process)

- **Critical path independence:** seeding, deposit, redeem, and connect must not depend on analytics APIs.  
- **Verify on-chain before telling operators “done.”** UI is necessary but not sufficient.  
- **One source of truth for chain id parsing**; no ad-hoc `parseInt(x, 16)` on chain ids.  
- **Cache policy:** never cache empty ownership as long-lived truth; provide explicit “reload from chain.”  
- **Release verification on mobile + WC** before calling a wallet fix “shipped.”  
- **Cache-bust checklist:** after deploy, confirm HTML/`BUILD_ID`/chunk hashes change on a clean client.  
- **Dual-vault discipline:** never change primary vault env without legacy set until legacy held ≈ 0.

### 6.3 Timeline lessons

Rapid sequential fixes without forcing client cache invalidation created the appearance that bugs “were not fixed.” That is a process failure equal in weight to the original defects.

---

## 7. Corrective Action Plan (CAP) — ongoing development

### 7.1 Principles

1. **Solvency and honesty over growth theater.**  
2. **Immutable contracts require dual-write migration plans, not silent repoints.**  
3. **Operator tooling must work offline/local if production edge fails.**  
4. **Optional data never blocks irreversible or capital-critical actions.**  
5. **No secrets in chat, logs, or client bundles.**

### 7.2 Engineering controls (mandatory)

| ID | Action | Acceptance criteria | Target |
|----|--------|---------------------|--------|
| CAP-E1 | Centralize `normalizeChainId` / `isRobinhoodChainId`; ban raw parseInt on chain ids via lint or code review checklist | Unit tests: `"4663"`, `"0x1237"`, `4663`, `"0x4663"` → Robinhood | Immediate |
| CAP-E2 | Bootstrap seed must accept manual ETH; pricing API optional | E2E: deposit+seed with pricing API mocked empty | Immediate |
| CAP-E3 | Inventory: never long-TTL empty; force refresh on treasury UI | Repro case: empty cache + balance 2 → shows 2 tokens | Immediate |
| CAP-E4 | App HTML Cache-Control: `max-age=0, must-revalidate` (or short s-maxage) for `/`, `/market`, `/learn` | `curl -I` shows no year-long s-maxage on HTML | Immediate |
| CAP-E5 | WalletConnect remains a **static asset** or paid Worker plan if bundled | Free Worker deploy stays under size limit | Ongoing |
| CAP-E6 | Automated smoke: deposit, seedShares, openPool, buy, sell, contributeLiquidity, removeLiquidity on local Hardhat | CI green on PR | Near-term |
| CAP-E7 | Feature flags for dual-vault + migrate panel independent of market enable | Can disable migrate without disabling market | Near-term |
| CAP-E8 | Structured error codes for vault UI (not only free text) | Support can map codes → runbooks | Near-term |

### 7.3 Product / UX controls

| ID | Action | Acceptance criteria |
|----|--------|---------------------|
| CAP-P1 | Keep `/learn` as canonical manual (human + AI); version a “last reviewed” stamp | Docs match live vault capabilities |
| CAP-P2 | Instant Swap always shows wallet share balance vs pool reserves | Users cannot confuse held NFTs with pool depth |
| CAP-P3 | Migrate UI fee disclosure remains mandatory | No migrate CTA without fee math |
| CAP-P4 | Seed UI shows connected address vs treasury address always | Wrong wallet is obvious |
| CAP-P5 | After open, suppress seed chrome completely | No confusing disabled OPEN buttons |

### 7.4 Operations / release controls

| ID | Action | Acceptance criteria |
|----|--------|---------------------|
| CAP-O1 | Release checklist: desktop inject, WC QR, mobile Safari, one wallet WebView | Sign-off before “wallet fix shipped” |
| CAP-O2 | Post-deploy: hit `/` and `/market` with cache-buster; confirm new `BUILD_ID` / version | Documented in PR template |
| CAP-O3 | Cloudflare: monitor Worker size, CPU, “paused deployment”; paid plan if TVL/public traffic grows | Runbook link in repo |
| CAP-O4 | Dual-vault change requires two-person review (or checklist): primary + legacy both set | No single-env vault flip |
| CAP-O5 | Pre-open: on-chain script print held, reserves, selectors, solvency | Operator keeps output |
| CAP-O6 | Secrets only in platform secret stores; rotate if ever pasted | No secrets in git or chat |

### 7.5 Security / trust controls

| ID | Action | Notes |
|----|--------|--------|
| CAP-S1 | Third-party audit before large TVL | Already stated in product docs |
| CAP-S2 | Never add admin withdraw of pool ETH without new security model | Preserves non-rug property |
| CAP-S3 | LP credits only from `contributeLiquidity`; raw transfers remain non-credited | Prevents fake remove claims |
| CAP-S4 | Public post-mortems omit keys, exploits as weaponized guides, and personal data | This document’s standard |

### 7.6 Communication plan (holders)

Without over-promising:

1. V1 deposits remain redeemable on legacy vault while dual mode is on.  
2. Migration is **optional**; fees are standard vault fees.  
3. V2 is the LP-capable Instant Swap book after open.  
4. Point users to `/learn` and Safe migrate UI for steps.  
5. Do not claim “all liquidity moved” from V1 pool ETH — it did not and cannot via admin.

---

## 8. Resolution statement (formal)

The organization resolves that:

1. The dual-vault configuration (V1 legacy + V2 primary) is the approved pattern for any future vault upgrade until a formally audited migration mechanism exists.  
2. Client defects that falsely blocked treasury bootstrap and wallet connect are treated as **severity-1 operator blockers** and are closed only after multi-client verification and cache-invalidation checks.  
3. On-chain verification of seed state is required before authorizing `openPool`.  
4. Ongoing development shall implement CAP-E*, CAP-P*, CAP-O*, and CAP-S* items above, tracked as durable engineering work—not one-off hotfixes.  
5. No compromising material (keys, secrets, personal credentials) shall be requested, stored, or reproduced in assistant sessions or public docs.

**Authorization to open V2:** Given verified held ≥ 1, pool shares &gt; 0, ethReserve &gt; 0, matching collection/treasury, and LP/buy/sell/deposit/redeem selectors present, **opening the pool is an operator product decision** with residual risk limited to **thin liquidity / price impact**, not to “incomplete deposit” of the seeded NFTs described in the pre-open check.

---

## 9. Appendix A — Public addresses (non-secret)

| Role | Address / id |
|------|----------------|
| Chain | Robinhood Chain `4663` |
| V1 vault (legacy) | `0xb2019Fd4cA24502e812C0C73b751Fa49979BF708` |
| V2 vault (primary at time of record) | `0xc4B29D7a01603D2A5937b1FC86ea85E488d72e04` |
| Collection | `0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156` |
| Market/vault fee treasury (public) | `0xcdb7ca36d35fa16d15fda859a46f1d72d979e9d8` |

*Confirm live primary/legacy via site env or explorer if addresses change after this document’s date.*

---

## 10. Appendix B — Pre-open verification checklist (reuse)

```
[ ] heldTokenCount >= 1
[ ] ethReserve > 0 and matches contract ETH balance
[ ] balanceOf(vault) > 0 (pool shares)
[ ] totalSupply consistent with held (+ pending redeem accounting)
[ ] collection() matches RobinWood
[ ] treasury() matches intended treasury
[ ] poolOpen == false before open; true after
[ ] Bytecode includes deposit, redeem paths, buyShares, sellShares
[ ] Bytecode includes contributeLiquidity + removeLiquidity if LP is marketed
[ ] Site PRIMARY points to this vault; LEGACY points to prior vault if any deposits remain
[ ] Operator completed openPool from treasury only
```

---

## 11. Document control

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-07-29 | Initial formal analysis, resolution, post-mortem, CAP |

**Authors:** Engineering / product incident record (compiled from operational session)  
**Review:** Recommended security + ops review before external distribution  
**Next review date:** 30 days after V2 open or upon next vault deployment, whichever is sooner  

---

*End of document.*

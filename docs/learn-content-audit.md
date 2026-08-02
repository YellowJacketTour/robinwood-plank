# /learn content audit

Scope: `components/learn/LearnGuide.tsx` as writing — disclosure, accuracy, quality, gaps, voice. Read the full file (1647 lines) and cross-checked claims against `lib/`, `contracts/`, and live chain state (RPC via `POST https://plank.love/api/rpc`, one Blockscout read). This is independent of, and does not duplicate, the scoping/audience plan.

Verified live during this audit: NFT `totalSupply()` = 1542 (matches §8's claim), chain id = 0x1237 = 4663, primary pool address resolves to `0xacE28f72Fc3e15eA1671e689806694A9b0cE047D` with `swapFeeBps()` = 30 (matches §18's "30 bps"), `BUY_GAS_RESERVE_ETH` = "0.004" (matches §6), `MARKET_DEFAULT_FEE_BPS` = 50 / 0.5% (matches §11), Trade fee 0.4207% (matches `lib/constants.ts:158`), collection is genuinely sold out (`MintPanel.tsx:43`). Where I say something is accurate below, this is the level of checking behind it — not a re-read of the prose.

---

## Disclosure findings (highest concern first)

### 1. §26 "Art, IPFS & local cache" — the proxy is documented hop-by-hop (lines 1115–1128)

The `Code` block gives the exact endpoint, its query parameter name, and its internal behavior:

```
metadata CID → image CID/path
  → /api/ipfs/image?uri=… (same-origin proxy, allowlisted gateways, redirect follow)
  → cached locally in the browser so return visits are instant
```

This tells a reader nothing they need to act on — nobody makes a decision based on knowing the proxy follows redirects through an allowlist. It does tell a probe exactly which endpoint takes a `uri=` parameter and that it will chase redirects, which is the shape of an SSRF/open-redirect fishing expedition, not incidental detail. This is close to a textbook example of "explaining how our defense works in a way that helps someone route around it."

**Recommendation:** cut to one sentence: *"Art and metadata are content-addressed on IPFS and served through our own domain, not raw third-party gateway links, so images load reliably and don't trip browser mixed-content blocks. Broken images are almost always a loading hiccup, not deleted art."* Drop the endpoint path, the parameter name, "allowlisted gateways," and "redirect follow" entirely — none of it is user-actionable.

### 2. §13 "Offers & criteria bids" — internal pipeline state described as a user-facing fact (lines 630–643)

*"The trait index is built from metadata and stored in the database; if empty, criteria UX degrades until reseeded."* This names the storage mechanism ("the database") and an internal operational term ("reseeded") for a maintenance state a user cannot cause or fix. It doesn't help a user (there's no action to take) and it tells an attacker that criteria-bid integrity depends on an index that can be emptied/rebuilt — a hint about where the soft spot in that feature is, for no reader benefit.

**Recommendation:** *"Criteria bids are checked against our own verified trait data, so a bidder can't smuggle in tokens that don't match. If this briefly shows fewer results than expected, it's catching up — try again shortly."* No mention of "database" or "reseeded."

### 3. §6 "Trade widget" — names an internal system ("the admin console") (lines 460–465)

*"The widget can still be paused from the admin console if something looks wrong with the route."* A user doesn't need to know a console exists, only that STAND BY is deliberate. Naming the control surface invites "where is this console" curiosity that the rest of the site doesn't otherwise surface. Low severity — it's not an address or a route — but unnecessary.

**Recommendation:** *"If you see STAND BY, that's deliberate — the widget can be paused if something looks wrong with the route, and waiting beats routing around it."* Drop "admin console."

### 4. §3 "Robinhood Chain" — reveals RPC failover behavior (lines 360–364)

*"Public RPC: … (rate-limited; the site prefers a private provider and falls back to this)."* This is an operational detail about which provider serves reads and under what condition it degrades to the public one. It doesn't change what a user does (nothing here is actionable — the site's RPC choice isn't something a reader configures), and it maps out the failover path for anyone probing for the weaker of the two endpoints.

**Recommendation:** drop the parenthetical, or shorten to *"(the site does not depend on this endpoint for its own reads, but you can query it directly to verify anything)."*

### 5. §2 "API routes" catch-all (lines 325–330) — acceptable, borderline

Listing route categories ("market orders, pool stats/held/activity, IPFS image/metadata proxy, Uniswap quote/swap, boards/airdrop, RPC proxy") is generic enough that it's all inferable from a network tab in ten seconds — this doesn't teach an attacker anything they couldn't get by opening devtools. It's also the one place that explicitly tells AI scrapers "APIs are implementation detail and may change shape; prefer documented public pages," which is a genuinely useful disclaimer. I'd leave this one as is; it's noise for a human reader but not a disclosure risk.

### Not flagged (already handled well)

§29's closing `Note` — deliberately declining to list hosting/caching/deployment "because it is operational detail... and publishing an inventory of it only helps someone probing for a way in" — is exactly the right instinct. The two items above (§26, §13) are the same category of information that slipped through elsewhere in the document; applying §29's own stated principle to them is the fix, not a new principle.

---

## Accuracy findings

### A. §30 Tutorial A directly contradicts §8 — the page tells a user to do something the page itself says is impossible

§8, in bold, twice: *"The collection is minted out... There is no supply left to mint at any price, and there will not be more."* Verified live: `totalSupply()` = 1542 = `MAX_SUPPLY`.

§30, Tutorial A "Your first plank" (lines 1202–1209):
```
1. Add Robinhood Chain 4663 to wallet; fund gas ETH.
2. Open plank.love → Mint; complete phase requirements.
3. Confirm mint; open Gallery or Market → My NFTs.
```
This walks a reader through a mint flow — "complete phase requirements," "confirm mint" — that cannot succeed, on a page that elsewhere insists there is nothing to mint "at any price." A new reader following the numbered tutorials top to bottom hits this contradiction in the very first walkthrough. This isn't a stale number, it's a leftover tutorial from before the collection sold out that nobody deleted when §8 was corrected. **Fix now, not as part of a larger rewrite** — either delete Tutorial A or replace its content with "get your first plank" via listing purchase / pool redeem, consistent with §8's own three ways to get a plank.

### B. FAQ headline uses a fabricated-but-unlabeled specific number (lines 1268–1272)

*"Why does the pool hold 57 planks but only ~5 shares are tradeable?"* Section 17 explicitly says numbers there are illustrative ("the shape, not the numbers — Instant Swap shows the live figures"), but the FAQ doesn't repeat that caveat — it states "57" and "~5" as if they're this pool's real figures, in a heading, which is the most-skimmed text on the page. A reader who checks Instant Swap and sees different numbers may reasonably wonder if the FAQ is wrong or stale, when it was never meant to be literal. **Fix:** either reference real live numbers by rendering them (technically possible via the same live-registry pattern `PoolTable` already uses) or explicitly flag them as illustrative in the question itself, e.g. "Why can a pool hold far more planks than its tradeable share count?"

### C. Everything I could check against code/chain checks out

Chain id 4663, all nine hardcoded addresses in §4 (byte-for-byte matched against `lib/constants.ts` and confirmed live on the rendered page), the 1%/1%/2.5% legacy fee schedule (`VAULT_FEE_DEFAULTS` in `vault-registry.ts`), the "current pool mints/burns exactly 1.000 share" claim, 30 bps swap fee (verified live via `eth_call`), 0.4207% trade fee, 0.004 ETH gas reserve, RobinWood 0% / other collections 0.5% default marketplace fee, and the rarity-tier description in §7 (Background-driven, Legendary top, no Mythic — matches `lib/rarity.ts`'s documented method exactly) are all accurate as written.

### D. Things that will rot silently — flag as a class, not one at a time

Several sections assert current-state facts with no built-in way to notice when they go stale, unlike §4's `PoolTable` (which reads live) or §23's `activePoolName()` (which resolves live). Examples: §6 "Trading is open" (a paused state has to be caught by whoever edits this page, not by the page); §11's fee note ("other future collections may use a default e.g. 0.5%") is phrased as roadmap and will read oddly once/if that actually happens; §15's "It has no oracle, no external AMM dependency, no owner-adjustable fees... impossible rather than merely unintended" is a strong claim about the *current* contract that would be simply wrong the day a fourth pool with different properties ships, with nothing forcing a revisit. None of these are wrong today. All of them are asserted with the same confidence as the live-read facts, so a reader can't tell which sentences will still be true next quarter and which are load-bearing on someone remembering to edit this file.

---

## Writing-quality findings

### §15 "The pools" is the single worst offender — audit report, not user guide (lines 664–740)

This section is ~75 lines and reads like an internal security review restated in second person: "no proxy, no upgrade, no admin switch," "asserts that after every call," "Fee ceilings are fixed in the constructor, so a high-fee deployment is impossible rather than merely unintended." A user opening this page to decide where to put a plank needs exactly three facts — *use Premium Plank Liquidity, Driftwood is fine to leave alone, do not touch WormWood* — and the section buries them under paragraphs justifying engineering decisions nobody asked to be convinced of. The "Solvency, in one line" `Note` at the end is good writing (it actually is one line of decision-relevant content); everything above it in the section is padding around that one note.

### §17/§18/§19/§23/FAQ repeat the same three facts five separate times

"Older pools charge in shares and a deposit doesn't quite cover a redeem; the current pool doesn't have this gap" is stated, near-verbatim, in §15, §18 (twice — once in the `Code` block and again in prose), §19's closing `P`, §23, and twice in the FAQ. Each individual restatement is fine; the cumulative effect across ten consecutive sections (§15–§24, a full third of the page) is that a reader who reads linearly gets the same three sentences over and over dressed in different section headers. This is the concrete version of "three paragraphs doing one sentence's work" — except spread across paragraphs *and* sections.

### §22 "Random redeem & drand" explains mechanism where a user needs a decision (lines 978–1004)

A user redeeming randomly needs to know: it's two steps (burn, then claim), it takes a wait, and if it stalls there are settle/forfeit controls. What they get is also a mini-lecture on drand as a public randomness network and "the on-chain beacon verifies its signatures, so the outcome cannot be steered by us" — trust-building copy that belongs in a "why this is fair" FAQ answer, not step 2 of an instructional list a user is trying to follow in the moment.

### §32 "AI machine summary" — legitimate, but its bulk falls entirely on human readers too

The JSON block is ~75 lines, and it's a genuinely useful machine-readable artifact for the stated purpose (scrapers). But every one of those lines currently renders in the same `<article>` a human reads top to bottom, at the very bottom of an already-long page, duplicating facts stated in prose sections above it (pool generations, fee models, the "not stuck if" list already covered in §19/FAQ). If it's meant for machines, it should not cost a human a scroll — see gap/recommendation below.

### Sections that would actually get finished by a real user

§0 (Start here), §8 (Minting is finished), and the FAQ are the strongest writing on the page — short, declarative, answer a real question a worried or confused user actually has. §4's `Warn` about WETH lookalikes and §19's `Warn` about raw transfers are exactly the right length and register: one sharp warning, no lecture. Most of §15–§24 and §26–§29 would not survive a real user's attention span; they read as written for the page's other two audiences (a trader auditing the mechanism, or an AI scraper), not the newcomer the TOC's "0. Start here" framing implies is the primary reader.

---

## Gaps — what's missing that a user actually hitting a wall would need

1. **No "I think I got scammed / this looks wrong" path.** §8 warns that any new "mint" isn't real and to verify the NFT address, and §4 warns to verify WETH by address not symbol — good instincts, both buried mid-document. There's no single, findable "if something looks off" section a panicking user would search for. The two warnings that exist are the right content; they need a home a scared user can find in one scroll, not two.
2. **No error-state guidance beyond deposits.** §19 covers "deposit reverted → you still own the plank" well. There's nothing for a failed Seaport fill, a failed swap, or a rejected/stuck wallet transaction generally — common real failure modes for a marketplace + AMM product, and currently entirely absent.
3. **No "before you approve/sign anything" checklist**, despite the content for one existing scattered across §4 (verify WETH), §8 (verify NFT address), §28 (verify pool address, prefer limited approvals), and the trade-widget lookalike-token warning in §6. These four warnings are the highest-value safety content on the page and they're the least discoverable, each sitting at the bottom of an unrelated section.
4. **§28 "Wallets & safety" is a flat bullet list with no priority ordering** — "never paste seed phrases" (obvious, universal) sits at the same visual weight as "verify the pool address... before a large approval" (specific, load-bearing, the thing someone is actually about to get wrong on this site). A user skimming a safety section reads the first two bullets and stops; right now the two most generic bullets lead.

---

## Voice and audience mismatch

The page is genuinely written for three different readers at once, and it shows in specific, findable ways rather than just being a vibe: the second-person tutorial voice ("Enter amount; server builds quote…"), the reassuring-explainer voice aimed at a nervous holder ("Is my plank safe if I do nothing? Yes."), and the machine/audit voice (§15's contract-property assertions, §32's JSON, the "AI note:" callouts sprinkled at §3/§4/end). None of these voices is bad on its own — the FAQ's reassuring voice is the best writing on the page, and §32's JSON is legitimately useful to its actual audience. The cost is that a human reader pays for the AI-scraper content in scroll length and register whiplash (prose → warning → contract-property assertion → JSON, sometimes within one section group), and the AI-scraper content pays nothing extra for being separated out, since it's all one `<article>` regardless of where the human/AI split falls. Splitting this — keep the JSON as machine-readable but stop rendering all ~75 lines of it inline for humans (a collapsed `<details>`, or a separate `/learn.json` a human page can link to once) — would let the human sections trim without losing anything from the AI-facing summary.

---

## Verdict: if this had to be one tenth its current length

Keep, near-verbatim: **§0 Start here**, **§8 Minting is finished**, **§4 Canonical addresses** (table + the WETH lookalike `Warn`), a trimmed **§18** (just the two fee-model contrast, no "old shortfall" essay), the **WormWood danger `Warn`** currently in §15 (three sentences: what it is, don't use it, how to exit), and a **consolidated safety block** built from the scattered warnings named in Gaps #3 above (verify NFT address, verify WETH address, verify pool address, no seed phrases, prefer limited approvals — five bullets, safety-relevant ones first).

Everything else — the two-layer pool model diagram, the drand mechanism writeup, the IPFS proxy internals, the IPFS/Seaport/infra dependency list, all five tutorials, the IPFS-cache section, the IPFS-shortfall math walkthrough, and the entire JSON block — either restates one of the six things above in more words, explains mechanism nobody needs to make a decision, or (§26 especially) discloses more than it helps. A user who reads only the six items above can safely get a plank, safely avoid WormWood, and know what to verify before signing anything, which is the actual job of a manual this product needs. The rest is documentation for people building against this system, not people using it, and would be better served as a separate technical reference than folded into the page a first-time holder is pointed to.

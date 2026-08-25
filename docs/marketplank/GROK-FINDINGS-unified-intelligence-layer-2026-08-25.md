# Grok findings: state-of-the-art unified wallet-intelligence layer (2026-08-25)

Response to a follow-up research ask, deliberately wider than
`GROK-FINDINGS-plank-koth-fraud-detection-2026-08-25.md` (the KOTH-specific
fraud-gate pipeline for the "largest single $PLANK buy" contest, preserved
unmodified — everything below assumes that document as the concrete,
already-shipped baseline and does not repeat its §1–§7). The operator's own
framing: *"produce a one shot state of the art all encompassing diverse
sources research into intelligence agency level solutions to these goals and
unified vision."* Read literally, that means two separable questions:

1. How do real intelligence-community, financial-crime-unit, and top-tier
   blockchain-forensics organizations approach wallet-risk and network
   analysis **as a discipline**, not as a one-off contest script — and which
   of their public, citable methods actually transfer to a small team running
   a real marketplace and a real token?
2. Could RobinWood/Marketplank's existing, currently-separate pieces (`lib/
   boards.ts` + `lib/boards-store.ts` "Bad Boards / Good Wood" reputation
   system, whatever wash-trade signal exists in the wash-trade-detection
   path, the new plank-koth fraud-gate pipeline, and `lib/plank-checks.ts`
   leaderboard/points logic) be unified into one reusable wallet-risk service
   the whole platform draws from, instead of staying a pile of independent
   checks that each reinvent "is this wallet suspicious"?

Same conventions as the prior two docs in this series: fail-closed, never
fabricate a number/incident/technique, every claim source-labeled, and
anything not independently verifiable is flagged as such rather than
invented. "Intelligence agency level" is treated honestly below — real
public frameworks (FATF, FinCEN guidance, Europol's own published typology
work, Chainalysis/TRM/Elliptic public methodology, peer-reviewed graph-
forensics papers) are cited where they exist; where the ask implies
classified or non-public tradecraft, that is stated plainly as unverifiable
rather than dressed up as sourced.

---

## 1. Real intelligence/financial-crime methodology mapped onto on-chain wallet graphs

**Block:** the ask wants "intelligence agency level" rigor. What's actually
public and citable, versus what would be inventing capability that isn't
documented anywhere open?

**Real, verified frameworks:**

- **FATF (Financial Action Task Force) Virtual Asset guidance.** FATF's
  "Updated Guidance for a Risk-Based Approach to Virtual Assets and VASPs"
  (most recent substantive version 2021, with follow-up targeted updates)
  is the actual multilateral-agency-level document underpinning how
  regulators expect VASPs to conduct blockchain analytics, including the
  "Travel Rule" (originator/beneficiary information for transfers above a
  threshold) and risk-based transaction monitoring expectations.
  ([FATF: Updated Guidance for a Risk-Based Approach to Virtual Assets and
  VASPs](https://www.fatf-gafi.org/en/publications/Fatfrecommendations/Guidance-rba-virtual-assets-2021.html))
  This is the real regulatory backbone that Chainalysis/TRM/Elliptic all
  build commercial tooling to satisfy — it is the *policy* layer, not a
  detection technique in itself, but it explains *why* the two-hop
  funding-source checks and address-clustering approaches below are the
  industry-standard shape rather than an arbitrary heuristic.
- **FinCEN.** FinCEN (part of the U.S. Treasury, not an intelligence
  agency but the actual U.S. financial-crime-unit analog the ask is
  gesturing at) has published advisories on convertible virtual currency
  and ransomware-related typologies (e.g., FIN-2021-A004 on ransomware and
  virtual currency), which describe **red-flag indicators** — rapid
  movement through multiple wallets, use of mixers, structuring deposits
  below reporting thresholds — that map directly onto on-chain heuristics.
  ([FinCEN Advisory FIN-2021-A004](https://www.fincen.gov/resources/advisories/fincen-advisory-fin-2021-a004))
  **Could not verify:** any FinCEN document naming graph-centrality
  algorithms specifically — their published guidance describes typologies
  (what to look for), not implementation techniques (how to compute it).
  Do not present FinCEN as a source for the *algorithms* below, only for
  the *behavioral red flags* they encode.
- **Europol.** Europol's European Cybercrime Centre (EC3) has publicly
  discussed cryptocurrency tracing capability in press releases tied to
  real takedowns (e.g., its role in mixer/ransomware-network
  disruptions), but Europol does not publish its internal analytic
  methodology — unlike FATF/FinCEN, there is no equivalent public
  "Europol crypto-intelligence handbook" to cite. **Flag: any claim about
  Europol's specific analytic techniques beyond what appears in its own
  press releases is not independently verifiable and is not asserted
  here.**
- **SIGINT/HUMINT-derived analytic concepts that do genuinely transfer,
  and are independently documented in the academic/industry literature
  under their own names (not because an agency published them, but
  because the underlying math is public regardless of origin):**
  - **Link analysis** — representing entities as nodes and relationships
    as edges, then reasoning over the graph — is a decades-old
    intelligence-analysis technique (popularized publicly via tools like
    Palantir Gotham and i2 Analyst's Notebook, both of which are
    documented as being used by law-enforcement/financial-crime units)
    and is structurally identical to blockchain address-clustering graphs.
    The *technique* (nodes/edges/graph traversal) is generic and public;
    what's not verifiable here is any specific agency's internal graph
    software or thresholds.
  - **Network centrality scoring** (degree, betweenness, eigenvector
    centrality) is standard graph theory, published and taught openly
    (Freeman's centrality measures, 1970s–80s), and is exactly the
    mathematical basis for identifying "controller" or "hub" addresses in
    a wash-trading fan-out network — this is the same shape as
    Chainalysis's publicly documented controller-address findings cited
    in the KOTH doc's §3 (183 sub-addresses per controller).
  - **Pattern-of-life analysis** — establishing a baseline of normal
    behavior for an entity, then flagging deviations — is a real,
    named SIGINT-adjacent analytic concept, and its blockchain analog
    (baselining a wallet's typical gas price, active hours, counterparty
    set, transaction size distribution, then scoring deviation) is
    exactly the statistical-anomaly-detection approach covered in §3
    below, under its own separate published name ("behavioral
    baselining" in fraud-detection literature) rather than an intelligence
    term of art.

**Solution design (what actually transfers to RobinWood):**

1. Treat FATF's red-flag typologies (rapid layering, structuring,
   mixer use, self-funding) as the **checklist**, not as an algorithm —
   they tell you *what* Bad Boards should be scoring for.
2. Treat link analysis + centrality scoring as the **data structure**:
   RobinWood's wallet graph (funding edges, common-gas-payer edges,
   temporal co-activity edges — see §2) should be modeled and queryable as
   an actual graph, not as ad hoc per-check SQL joins, precisely so that
   centrality-style questions ("is this wallet a hub feeding many
   sub-wallets?") become answerable once instead of requiring a bespoke
   query per feature.
3. Treat pattern-of-life/baselining as the justification for keeping
   **per-wallet historical state** (which Bad Boards already does via
   `boards-store.ts`) rather than only ever evaluating a wallet in
   isolation at the moment of a single suspicious transaction.

**What you get:** a defensible, citable rationale for the graph-based
architecture proposed in §6 — it's not "we invented a scoring system," it's
"we implemented the same conceptual shape FATF's guidance assumes and named
academic graph techniques provide, at a scale that fits a single marketplace
instead of a national financial system."

**What you don't get:** actual intelligence-agency tooling, data-sharing
access, or classified tradecraft — nothing in this section claims RobinWood
can replicate a government agency's non-public capability, and the ask's
phrase "intelligence agency level" is answered honestly as "the same public
methodology base agencies' own published guidance describes and commercial
forensics firms implement," not as "the same non-public tools."

**Confidence:** High on FATF and FinCEN citations (primary sources, direct
URLs). Medium on Europol — real organization, real public involvement in
crypto-crime takedowns, but no citable methodology document exists to point
to, and that gap is stated rather than papered over. High on link
analysis/centrality as generic, publicly documented graph theory with no
agency-specific claim attached.

---

## 2. Graph-based wallet clustering at scale: real techniques and real build-vs-buy costs

**Block:** who is really behind a wallet, at scale, without paying for
Chainalysis/TRM/Elliptic access?

**Real, verified academic/industry lineage:**

- **Meiklejohn et al., "A Fistful of Bitcoins: Characterizing Payments
  Among Men with No Names" (IMC 2013)** is the foundational, widely-cited
  paper establishing the **multi-input heuristic**: in Bitcoin's UTXO
  model, if a transaction spends multiple inputs together, those inputs'
  addresses are very likely controlled by the same entity (since spending
  requires the private keys for all inputs). This is the origin of modern
  address-clustering-based blockchain forensics and is cited by name in
  essentially every subsequent academic blockchain-forensics paper.
  ([ACM IMC 2013 / widely mirrored, e.g. UCSD CSE
  citation](https://cseweb.ucsd.edu/~smeiklejohn/files/imc13.pdf))
- **EVM-chain equivalents** (no UTXO multi-input heuristic exists on
  account-based chains like Robinhood Chain, so the clustering heuristics
  are structurally different, not a direct port):
  - **Common funding source** — multiple wallets first funded by the same
    address (the same heuristic the KOTH doc's §3 already cites via
    Chainalysis's NFT wash-trading methodology) is the closest EVM analog
    to Meiklejohn's multi-input clustering, and is the single most
    commonly cited EVM clustering heuristic across published forensics
    write-ups.
  - **Common gas-payer / sponsor pattern** — on account-abstraction or
    relayer-sponsored flows, multiple "different" wallets whose gas is
    consistently paid by the same sponsor address are a documented
    clustering signal in ERC-4337/paymaster-era forensics discussion
    (general industry pattern; **could not find one single canonical
    academic paper naming this specific heuristic** — flagged as
    reasoned-from-mechanics rather than directly cited).
  - **Temporal co-activity** — wallets that reliably transact within
    tight time windows of each other (e.g., always active in the same
    block or same few-second window across many separate events) is a
    documented statistical clustering signal used in graph-based fraud
    detection (see Elliptic dataset discussion in §3), though it is a
    probabilistic signal, not proof, and produces false positives for
    coincidentally-correlated but unrelated bot activity.
  - **Contract-deployment fingerprinting** — wallets that deploy
    contracts with identical bytecode, identical constructor-argument
    patterns, or via the same deployer/factory contract are a real,
    commonly used clustering signal in scam/rug-pull tracking
    write-ups (e.g., how researchers link "serial rug deployer" wallets
    across many token launches) — real technique, but this specific
    citation is industry-blog-level prior art rather than a single
    peer-reviewed source; treat as verified-by-mechanism, not
    verified-by-formal-citation.

**Build vs. buy, honestly priced:**

| Option | What it gets you | Real cost |
|---|---|---|
| **In-house heuristic clustering** (funding-source graph, gas-payer graph, temporal co-activity, deployer fingerprinting) on Robinhood Chain's own free RPC/Blockscout data | Everything in §2 above, scoped to wallets that have touched RobinWood/$PLANK specifically | $0 marginal cost beyond engineering time; bounded by free-RPC rate limits (same FBC/singleflight discipline as the rest of this repo) |
| **Chainalysis Reactor / KYT** | Cross-chain entity resolution, sanctions-list matching, a maintained global clustering graph built from far more data than one app can ever observe | **Not publicly priced** — Chainalysis sells enterprise contracts with custom quotes; no public price list was found in this research pass. Do not state a number. |
| **TRM Labs** | Similar cross-chain forensics, API access | **Not publicly priced** — same as above, enterprise sales-quote model; TRM does publicly note free API access exists for the **TRM Wallet Screening** tier for qualifying uses in some public materials, but exact current terms were not independently verified in this pass — flag before relying on it. |
| **Elliptic** | Similar; also publishes the well-known **Elliptic Data Set** (Bitcoin transaction graph with fraud/licit/unknown labels) used broadly in academic fraud-detection research (see §3) | **Not publicly priced** for the commercial product; the labeled dataset itself is public/free for research use. |
| **Arkham Intelligence API** | Wallet labels via its Intel Exchange (see §5), portfolio/entity tracking | Arkham publicly documents a **free tier and paid API tiers** for its Intel platform, but this research pass could not confirm current exact price points with confidence — treat any specific dollar figure as unverified until checked against Arkham's live pricing page at build time. |

**Honest bottom line on pricing:** none of Chainalysis/TRM/Elliptic publish
public per-seat or per-call pricing — this is universally reported (in
industry commentary, not a primary source) as "contact sales," and this
document will not invent a number. Arkham is the one vendor in this space
that has *some* public self-serve tier language, but even that should be
re-verified live before being cited as fact in any planning document.

**Solution design for RobinWood specifically:**

1. **Build in-house first.** Every heuristic RobinWood actually needs for
   its own $PLANK/marketplace graph (funding source, gas-payer, temporal
   co-activity, deployer fingerprinting) is buildable from data
   Robinhood Chain's own Blockscout instance already exposes for free —
   this is a strict superset of what the KOTH doc's §3 already committed
   to building, generalized into a reusable service (§6).
2. **Do not budget for a paid vendor contract based on this contest
   alone.** A 31-day single-token contest does not justify an enterprise
   forensics contract with unknown, non-public pricing; the in-house
   heuristics cover the realistic threat model at RobinWood's actual
   scale.
3. **Revisit vendor access only if/when RobinWood needs cross-chain
   or cross-platform correlation it structurally cannot get from its own
   chain's data** — that is a real, separate threshold discussed honestly
   in §4, not a reason to buy access today.

**What you get:** a scoped, honest build-vs-buy decision instead of either
"go build a Chainalysis clone" or "just buy an enterprise contract we can't
even get a price for."

**What you don't get:** RobinWood's in-house graph will only ever see
wallets and funding paths that touch chains/data sources it actually
indexes — it will never have the breadth of a vendor that ingests dozens of
chains and exchange-reported data. That gap is real and is why §4 exists.

**Confidence:** High on Meiklejohn et al. as the foundational, correctly-
cited academic source. High on funding-source/temporal/deployer heuristics
as real, commonly used techniques. Low/unverified on all commercial vendor
pricing — explicitly flagged rather than guessed, per the ask's own
instruction not to fabricate a number.

---

## 3. Real-time ML anomaly detection: what's published, and an honest cost/benefit call

**Block:** should RobinWood stand up real ML (isolation forests, graph
neural networks) for this, or is the rule-based pipeline already built in
the KOTH doc sufficient?

**Real, verified published work:**

- **The Elliptic Data Set** is a real, publicly released dataset (~200k
  Bitcoin transaction nodes, ~234k edges, ~166 features per node, with a
  subset labeled licit/illicit) explicitly built and released by Elliptic
  in partnership with academic researchers (MIT, IBM) to benchmark
  machine-learning fraud detection on blockchain transaction graphs. It is
  the most widely cited public benchmark in this exact space.
  ([Elliptic Data Set — Kaggle mirror / original release, widely
  cited](https://www.kaggle.com/datasets/ellipticco/elliptic-data-set))
- **Graph Neural Networks (GNNs) for financial fraud detection** are a
  real, active academic research area — GNN-based models (e.g., Graph
  Convolutional Networks, GraphSAGE-style architectures) have been applied
  specifically to the Elliptic dataset in multiple published papers
  benchmarking illicit-transaction classification, generally reporting
  meaningfully better precision/recall than plain logistic regression or
  random forest baselines on that specific dataset (Weber et al., "Anti-
  Money Laundering in Bitcoin: Experimenting with Graph Convolutional
  Networks for Financial Forensics," 2019, is the commonly cited original
  paper introducing GNN benchmarking on the Elliptic data).
  ([arXiv:1908.02591](https://arxiv.org/abs/1908.02591))
- **Isolation forests** are a real, general-purpose unsupervised anomaly-
  detection algorithm (Liu, Ting, Zhou, 2008, "Isolation Forest") — widely
  used across fraud detection generally, not blockchain-specific, and
  valuable specifically because it doesn't require labeled fraud examples
  (unlike GNN classification on Elliptic-style labeled data), which
  matters because RobinWood has **no labeled fraud dataset of its own**.
  ([Liu et al., IEEE ICDM 2008 — "Isolation
  Forest"](https://cs.nju.edu.cn/zhouzh/zhouzh.files/publication/icdm08b.pdf))

**Honest assessment for a single 31-day contest:**

Standing up real-time ML for this contest specifically is **not
justified**, for reasons grounded in the above, not general skepticism of
ML:

1. **No labeled training data exists for $PLANK.** GNN classification
   approaches (Weber et al.-style) require labeled illicit/licit
   examples to train against; RobinWood has zero historical labeled fraud
   cases for its own token. An isolation forest doesn't need labels, but
   still needs a meaningful volume of "normal" transaction history to
   establish a baseline distribution — a single new pool over 31 days is
   thin training data by construction.
2. **The rule-based pipeline in the KOTH doc already covers the known
   attack surface** (flash-loan round-trips, router misattribution,
   funding-source self-financing, decoy pools, reorg timing) using
   heuristics that are individually well-documented and don't need a
   model to detect — they're structural/deterministic checks (was this
   atomic, was this the canonical pool, was this attributed correctly),
   not statistical outlier detection. ML adds the most value precisely
   where the fraud pattern is *not* known and structural in advance — the
   opposite of this contest's fully-specified attack surface.
3. **Where lightweight statistical scoring (not full ML) is worth
   adding cheaply:** a simple, unsupervised anomaly score (e.g., z-score
   or percentile rank of a wallet's funding-graph in-degree, transaction
   timing versus RobinWood's own historical baseline) as one more signal
   feeding into the manual-review queue is cheap, explainable, and useful
   — this is far short of "standing up a GNN," and is the correct-sized
   version of §1's "pattern-of-life baselining" concept.

**Solution design:**

- **For this contest:** do not build ML. The rule-based, cited-heuristic
  pipeline is the right-sized tool, matching the KOTH doc's own
  conclusion.
- **For the platform longer-term (§6):** once the unified wallet-risk
  service (below) has accumulated enough real transaction/label history
  across the marketplace (not just this one contest), a lightweight
  isolation-forest-style unsupervised anomaly score becomes a legitimate,
  cheap addition to the service's scoring inputs — explicitly *not* a GNN,
  since RobinWood will likely never have Elliptic-scale labeled data to
  train one meaningfully, and an over-engineered model on thin data is a
  worse outcome than a well-tuned isolation forest or even just percentile
  thresholds on the heuristic features already being computed.

**What you get:** an honest "not yet, and here specifically is when it
would become worth it" answer instead of either dismissing ML wholesale or
recommending it reflexively because the ask asked about it.

**What you don't get:** a promise that ML will meaningfully outperform the
existing heuristics for RobinWood's actual scale — the published GNN
results are benchmarked on Elliptic's dataset (a large, established
Bitcoin subgraph), and there is no evidence in this research pass that
those gains transfer to a single new token's 31-day contest with no
comparable data volume.

**Confidence:** High on all three citations (Elliptic dataset, Weber et
al. GNN paper, Liu et al. isolation forest paper — all real, primary,
verifiable). High on the "don't build ML for this contest" conclusion,
reasoned directly from the data-volume/labeling gap, not a guess.

---

## 4. Cross-chain / cross-platform identity correlation: real techniques and real limits

**Block:** can a wallet's behavior on Robinhood Chain be linked to its
behavior elsewhere (other chains, other marketplaces) to catch a repeat bad
actor who simply moves chains?

**Real, verified techniques:**

- **Shared funding source across chains** — if the same CEX withdrawal
  address, the same bridge deposit address, or the same "home" wallet
  funds addresses on two different chains, that funding-path overlap is a
  real, commonly used cross-chain correlation signal, structurally
  identical to the single-chain funding-source heuristic in §2/KOTH-doc
  §3, just applied across bridge/CEX boundaries instead of within one
  chain's own address space.
- **Transaction-timing fingerprinting** — a wallet/bot with a
  characteristic timing signature (e.g., always transacting within N
  seconds of a specific block-time offset, or with a distinctive gas-
  price-setting pattern) can sometimes be correlated across chains if the
  same automation/bot infrastructure operates on both — this is a real,
  discussed technique in blockchain-forensics community write-ups
  (bot-fingerprinting via timing/gas patterns), but **no single
  peer-reviewed paper specifically validating cross-chain timing
  correlation at scale was found in this research pass** — flagged as a
  plausible, mechanism-grounded technique rather than a directly cited,
  formally validated one.
- **ENS and identity-service correlation** — ENS (Ethereum Name Service)
  names, and similar naming/identity layers, are public, on-chain, and
  can genuinely link an address to a human-chosen identifier that the
  same person may reuse (e.g., the same ENS name pointed at from multiple
  addresses, or address-to-ENS reverse resolution surfaced in wallet UIs)
  — ENS itself is a real, documented, standard protocol
  ([ens.domains](https://ens.domains)), and using ENS reverse-resolution
  as a low-confidence identity hint is a real technique used broadly
  across wallet-facing tools (Etherscan, Blockscout, and others resolve
  and display ENS names for exactly this reason).

**Honest limits — what is genuinely undiscoverable without CEX-level KYC:**

- **No public on-chain tool, including Chainalysis/TRM/Elliptic's
  commercial products, can deanonymize a wallet to a real-world identity
  purely from on-chain data.** Their actual capability (as publicly
  described in vendor marketing and reporting on real law-enforcement
  cases) comes from combining on-chain clustering with **off-chain data
  they've licensed or been given by exchanges under KYC/AML/subpoena
  processes** — i.e., the deanonymization step is fundamentally a
  centralized-data problem, not a purely cryptographic/graph-analytic
  one. RobinWood has no access to that off-chain data source and no
  legal basis to compel it, and this document does not pretend
  otherwise.
- **A sophisticated actor who never touches a KYC'd exchange, never
  reuses an ENS name, and varies bridge/funding paths per chain is
  genuinely outside what any of the above techniques can reliably
  connect.** This is a real, stated limit in the forensics literature
  generally (attribution confidence degrades sharply once an actor uses
  privacy-preserving hop patterns or CEX-free funding), not a RobinWood-
  specific weakness.

**Solution design:**

1. Within the unified wallet-risk service (§6), store cross-chain funding
   hints (bridge deposit/withdrawal addresses seen funding a wallet that
   also touched RobinWood) as a **low-confidence signal**, weighted
   accordingly — never as a disqualifying fact on its own.
2. Surface ENS reverse-resolution (already a near-zero-cost RPC call) as
   display metadata in Bad Boards profiles — genuinely useful for a human
   reviewer's judgment call, not something to score numerically.
3. Explicitly do not claim, in any product copy or internal doc, that
   RobinWood can "deanonymize" wallets — the honest claim is "raise or
   lower risk confidence using public, replicable signals," consistent
   with how the KOTH doc's §3 already treats its 2-hop funding check as a
   flag, not proof.

**What you get:** a correctly-scoped, non-overpromising cross-chain signal
layer.

**What you don't get:** true identity resolution — that requires KYC data
RobinWood does not and should not try to obtain outside lawful process.

**Confidence:** High on funding-source correlation and ENS as real,
verifiable mechanisms. Medium on timing-fingerprint cross-chain
correlation (plausible, not formally validated in citable literature
found here). High on the "no public tool deanonymizes purely from on-chain
data" limit — this is a broadly and consistently reported characteristic
of the entire industry, not a single contestable claim.

---

## 5. Arkham Intelligence's Intel Exchange: a real, citable crowdsourcing model

**Block:** could Bad Boards become crowdsourced/incentivized rather than
purely internal, and is Arkham's model a legitimate real-world precedent to
point to?

**Real, verified facts about Arkham:**

- Arkham Intelligence operates a platform explicitly built around
  **crowdsourced wallet/entity labeling with a financial incentive
  layer**, marketed as the "Intel Exchange" — a marketplace where users
  can post bounties for identifying the entity behind a wallet address,
  and other users submit intelligence to claim the bounty, paid in
  Arkham's own token (ARKM). This is a real, documented, live product,
  not a rumor — Arkham has publicly described this model in its own
  platform materials and it has been covered in mainstream crypto press.
  ([Arkham Intelligence — Intel
  Exchange](https://www.arkhamintelligence.com/), general product
  description corroborated across multiple industry press pieces at
  launch)
- The general mechanism — pay real users for real, verifiable
  intelligence about who controls a wallet — is a genuinely novel
  incentive structure relative to purely internal analyst-driven labeling
  (Chainalysis/TRM/Elliptic all use internal analyst teams plus licensed
  data, not a public bounty marketplace for labels).

**Real, documented criticisms/controversies (only citing what is
independently known to be real, not invented for symmetry):**

- **Incentive-to-fabricate risk is a structurally obvious and widely
  discussed criticism of any pay-for-label model**: a bounty marketplace
  for "who owns this wallet" creates a direct financial incentive to
  submit plausible-looking but false or unverifiable claims, especially
  for high-value bounties, and this is the standard criticism raised in
  general commentary about the Intel Exchange model. **This document
  could not verify a specific, named, documented incident of proven false
  labeling on Arkham's platform** — the criticism is a structural/
  design-level one commonly raised about the model, not a citation to a
  confirmed fraud event, and it should be presented as such rather than
  as "Arkham has been caught doing X."
- **Doxxing/privacy concerns**: because the entire point of the Intel
  Exchange is attaching real-world identity to a wallet, it has drawn
  general privacy criticism common to any wallet-deanonymization
  marketplace — again, a structural criticism of the category, not a
  specific verified incident cited here.

**Applied to RobinWood's Bad Boards:**

**Solution design:**

1. **Arkham's model is a real, legitimate precedent for the concept** of
   crowdsourced wallet labeling with incentive alignment — RobinWood does
   not need to invent this idea from nothing; it can point to a live,
   real product as prior art.
2. **A direct clone (pay-for-label bounty marketplace) is likely
   oversized for RobinWood's actual problem.** Bad Boards exists to
   protect a specific marketplace/token's launch windows and contests,
   not to build a general wallet-attribution product for the whole
   industry — a full bounty economy is a different, much larger product
   than what RobinWood needs.
3. **A right-sized version worth building:** a **low-stakes community
   flagging mechanism** layered on top of Bad Boards — verified
   marketplace users (not anonymous, ideally wallet-signature-
   authenticated per the existing repo's BIP-322-adjacent verification
   patterns used elsewhere) can submit a flag ("this wallet did X") with
   evidence (a tx hash), which enters a **pending, unweighted** state
   until either (a) an internal reviewer confirms it, or (b) enough
   independent flaggers with no funding/behavioral link to each other
   corroborate it — directly reusing the "statistical agreement with
   k independent reporters" pattern the free-remedies doc already
   proposed for its own Client Contribution Relay concept, applied here
   to wallet reputation instead of price data.
4. **Do not attach a token/monetary bounty to this**, at least not as a
   v1 — that is exactly the incentive-to-fabricate structural risk
   flagged above, and RobinWood does not need to import Arkham's
   highest-risk design choice to get the crowdsourcing benefit; unpaid,
   reputation-gated community flagging (a "you'll be right or your
   flagging privilege gets revoked" model) captures most of the value
   with much less fabrication incentive.

**What you get:** a real precedent to point to (Arkham is genuinely doing
this, at scale, today) and a scoped, lower-risk way to borrow the concept
without importing its most-criticized design choice.

**What you don't get:** proof that crowdsourced labeling, even unpaid, is
free of manipulation — a coordinated group of accounts could still attempt
to corroborate a false flag against a competitor's or rival's wallet; this
is why the design above keeps community flags as one weighted input into
review, never as an auto-disqualifying signal on its own, mirroring the
KOTH doc's own "flag, don't auto-disqualify" posture for probabilistic
signals.

**Confidence:** High that Arkham's Intel Exchange is a real, live,
correctly-described product (primary source is Arkham's own platform,
corroborated by independent press coverage at launch). Medium on the
criticisms — the incentive-to-fabricate concern is a real and obvious
structural critique widely raised in commentary, but this pass found no
single, named, confirmed incident to cite as proof it has actually
happened on Arkham specifically, and that gap is stated rather than
papered over.

---

## 6. Synthesis: a Unified Wallet-Risk Intelligence Layer

**Block:** RobinWood currently has (at minimum) four separate systems that
each independently answer some version of "is this wallet suspicious":
`lib/boards.ts`/`lib/boards-store.ts` (Bad Boards / Good Wood reputation,
built for the launch-day sniper-trap window), a wash-trade signal check,
the new plank-koth fraud-gate pipeline (canonical-pool allowlisting,
same-tx round-trip detection, router attribution, 2-hop funding check),
and `lib/plank-checks.ts` (leaderboard/points gating). Each was built for
its own moment. None of them currently share a wallet-risk data model,
which means every new feature that needs "is this wallet trustworthy"
either re-derives the answer from scratch or doesn't ask the question at
all.

**Why unify, concretely (not just "architecture is nice"):**

- A wallet flagged by the KOTH pipeline's funding-source check today has
  no mechanism to make Bad Boards more cautious about that same wallet
  tomorrow, in an unrelated marketplace listing — the signal is computed
  and then discarded at the contest boundary.
- A wallet that Bad Boards already knows is a repeat sniper-trap violator
  is not consulted by the KOTH pipeline's manual-review queue, even
  though that history is exactly the kind of pattern-of-life prior (§1)
  that should raise the review priority of a borderline case.
- Every new feature (the next contest, the next marketplace mechanic)
  that needs a wallet-risk check currently means writing a fifth
  bespoke check instead of calling one already-built service.

**Proposed architecture — Wallet Risk Service (WRS):**

```text
                    ┌─────────────────────────────┐
                    │   WALLET RISK SERVICE (WRS)   │
                    │  single Postgres-backed graph │
                    │  + scoring API, read/write     │
                    └───────────────┬───────────────┘
                                    │
        ┌───────────────┬──────────┼──────────┬───────────────┐
        │               │          │          │               │
   Bad Boards /    wash-trade   plank-koth  plank-checks   (future
   Good Wood       signal       fraud gate  leaderboard     features)
   (sniper-trap    (marketplace (contest    (points/
   window)         listings)    candidates) gating)
        │               │          │          │               │
        └──── writes signals into WRS graph ──┴───────────────┘
                    (funding edges, gas-payer edges,
                     temporal co-activity, flags, review outcomes)
```

**Data model (the core unification, concretely buildable in Postgres —
this repo's own stated constraint elsewhere in this doc series is
"Postgres-only," which this respects):**

- `wallet_nodes(address, first_seen_at, ens_name, risk_score, risk_updated_at)`
- `wallet_edges(from_address, to_address, edge_type, first_seen_at,
  tx_hash)` — `edge_type` in `{funded_by, gas_paid_by, same_block_active,
  deployer_of}`, directly implementing §2's four clustering heuristics as
  first-class graph edges instead of one-off queries.
- `wallet_signals(address, source, signal_type, severity, evidence_json,
  created_at)` — every existing check (Bad Boards violation, wash-trade
  flag, KOTH funding-hit, plank-checks anomaly) writes here instead of
  keeping its own private state, `source` labeled honestly per this doc
  series' own labeling convention (never silently merged into an
  unattributed number).
- `wallet_reviews(address, reviewer, outcome, notes, created_at)` — the
  manual-review-queue outcome from any consuming feature becomes durable
  history other features can read, closing the "KOTH flags it, Bad Boards
  never hears about it" gap above.
- A single `computeRiskScore(address)` function (pure, testable, same
  spirit as `king-of-the-hill-rules.ts`'s I/O-free design) that reads
  `wallet_signals` + `wallet_edges` and produces one explainable score
  with a breakdown by contributing signal — never a black-box number.

**v1 — realistic before the contest's 31 days are up:**

1. **Do not block the contest on this.** The KOTH pipeline's own
   already-designed checks (§1–§4 of the KOTH doc) ship as specified,
   unchanged — this is additive infrastructure, not a rewrite dependency.
2. **Minimum viable unification achievable in-window:** stand up the
   `wallet_signals` table only, and change exactly two write sites —
   Bad Boards' existing violation recording and the KOTH pipeline's
   manual-review-queue entries — to also write into this shared table
   with honest `source` labels. This alone closes the single biggest gap
   (KOTH and Bad Boards not talking to each other) with minimal surface
   area and no risk to the contest's own ship date.
3. **Do not build the full graph (`wallet_edges`) or the crowdsourced
   flagging concept from §5 within the 31-day window** — both are real
   value-adds but neither is required for contest integrity, and rushing
   the graph schema under contest deadline pressure risks getting the
   edge-type taxonomy wrong in a way that's expensive to migrate later.

**Longer-term vision (post-contest):**

1. Build out `wallet_edges` as the real clustering graph (§2's four
   heuristics), backfilled from Robinhood Chain history for wallets
   already known to `wallet_nodes` — this turns the funding-source check
   from a per-candidate live RPC walk into a maintained, queryable graph,
   directly enabling real centrality-style questions (§1) like "which
   addresses are hubs feeding the most flagged sub-wallets."
2. Add the low-stakes community-flagging layer from §5 as an additional
   `wallet_signals` source (`source: community_flag`), gated by the
   k-independent-corroboration pattern already proposed, unpaid, reusing
   existing wallet-signature verification patterns in this repo.
3. Only once real signal volume and (ideally) some confirmed-fraud
   history exists, revisit §3's lightweight isolation-forest-style
   unsupervised score as one more `wallet_signals` source — explicitly
   not before there's enough real data to make that meaningful, per §3's
   own conclusion.
4. Every future feature (next contest, next marketplace mechanic) queries
   `computeRiskScore(address)` once instead of writing a sixth bespoke
   check — this is the actual "unified vision" the ask asked for: one
   service, many honest signal producers, one explainable score, reused
   everywhere.

**What you get:** a real, buildable, Postgres-only architecture that
starts as a two-table, two-write-site change fitting inside the contest
window, and grows into the graph-based, centrality-aware, crowdsourced-
labeling system the earlier sections research — without ever requiring a
paid vendor contract or an ML system the data doesn't yet justify.

**What you don't get:** a finished system today. This section is
explicitly a v1/vision split, not a claim that the full Wallet Risk
Service exists or ships before the contest ends — building `wallet_edges`
and the community-flagging layer is real, scoped, future work, stated as
such rather than implied as already done.

**Confidence:** High that the proposed v1 (shared `wallet_signals` table,
two write-site changes) is realistically buildable inside the contest
window without risk to the KOTH pipeline's own ship date — it is additive
and touches no existing logic in `king-of-the-hill-rules.ts` or the fraud
gate itself. Medium on exact `wallet_edges` schema surviving unchanged
into the longer-term build — flagged as a design to validate against real
data once backfilling begins, not a finished spec.

---

## Synthesized recommendation

Across §1–§6, the honest picture is: the "intelligence agency level"
framing is best answered as "the same public methodology base FATF,
FinCEN, and commercial forensics firms (Chainalysis/TRM/Elliptic) actually
publish and use — link analysis, funding-source clustering, pattern-of-
life baselining — implemented at RobinWood's own scale," not as access to
non-public agency tooling, which does not exist for a small team to
acquire and this document does not pretend otherwise. Real ML (GNNs) is
academically well-supported but not justified yet given RobinWood has no
labeled fraud data and the contest's attack surface is already covered by
deterministic rules. Arkham's Intel Exchange is a real, citable precedent
for crowdsourcing Bad Boards, but its bounty-token design carries a real,
structural fabrication-incentive risk not worth importing wholesale.

**The single most actionable near-term recommendation:** ship the
minimum-viable unification in §6's v1 — one new `wallet_signals` Postgres
table, and two small write-site changes (Bad Boards' existing violation
recorder, and the KOTH pipeline's manual-review-queue entry point) so both
systems write to a shared, honestly-labeled signal store. This is small,
additive, does not touch `king-of-the-hill-rules.ts` or delay the contest,
and is the one change that immediately stops RobinWood's fraud signals
from being thrown away at each feature's boundary — the concrete first
step toward the "one wallet-risk service, reused everywhere" vision the
operator asked for, achievable inside the 31-day window rather than
deferred to an unscoped future rewrite.

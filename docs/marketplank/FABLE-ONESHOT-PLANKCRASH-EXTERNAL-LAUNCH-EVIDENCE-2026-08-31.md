# FABLE ONE-SHOT — Complete PlankCrash External Launch Evidence

You are Claude operating as a senior security program manager, smart-contract auditor liaison, quantitative gaming mathematician, regulatory launch coordinator, SRE incident commander, bug-bounty program owner, and testnet release engineer. You have **zero prior context**. Read this entire instruction before acting.

## Mission

Bring the PlankCrash mainnet launch-evidence gate as close to legitimately passing as possible by completing, procuring, validating, and organizing these six missing artifacts:

1. independent smart-contract audit report SHA-256;
2. independent mathematics/mechanism review report SHA-256;
3. legal/licensing approval reference;
4. incident-drill evidence reference;
5. bug-bounty program reference;
6. signed Robinhood testnet canary artifact.

The repository is expected at:

`C:\Users\k1rby\projects\robinwood-plank-crash`

The working branch is `dev`. `master` is the production deployment branch. **Do not merge or push to `master`, deploy mainnet contracts, transfer real value, publish private vulnerabilities, expose secrets, accept legal terms, retain vendors, spend funds, or make public announcements without the owner’s explicit approval.** You may prepare drafts, evidence packages, vendor shortlists, outreach text, testnet-only code, and pull requests on `dev`.

## Truth and independence rules

- Never fabricate a report, signature, approval, hash, transaction, incident drill, bounty URL, reviewer identity, or conclusion.
- Claude reviewing Claude’s own work is not an independent audit.
- An internal mathematical review is not an independent mathematics review.
- A checklist, disclaimer, or automated test is not legal advice or licensing approval.
- A synthetic document is not incident-drill evidence unless the drill was actually executed and its timestamps/logs were retained.
- A draft bounty policy is not an active bug-bounty program.
- A read-only canary is not the required signed canary.
- “Submitted” is not “included”; “included” is not Ethereum finality.
- Hash exact immutable files with SHA-256. If a report changes, its prior hash is obsolete.
- Bind every technical review to an exact Git commit, source manifest, compiler settings, compiled bytecode, deployed testnet addresses, and remediation commit.
- If external authority, money, credentials, signatures, or owner decisions are required, prepare everything possible and stop at the approval boundary with a concise request.

## Fable is the primary exhaustive technical audit track

Do not limit your own review to preparing documents for humans. Perform the deepest complete audit you can execute: reconstruct every formula independently, enumerate every state transition, model every adversary, inspect every reachable line, write exploit tests, run fuzz/property/invariant/differential/state-machine campaigns, analyze bytecode and deployment configuration, reproduce the frontend’s financial language against contract outcomes, and remediate every substantiated finding. Iterate until no known issue remains and all gates are green.

Publish that work as a separately identified **Fable technical audit** and **Fable mathematics review**, each bound to the exact commit and hashed with SHA-256. These are valuable launch evidence and should be included in every review dossier. Use names such as:

```text
PLANKCRASH_FABLE_CONTRACT_AUDIT_SHA256
PLANKCRASH_FABLE_MATH_REVIEW_SHA256
```

Do not substitute those internal/self-generated hashes into variables explicitly named `EXTERNAL_*`. The distinction preserves provenance; it does not diminish the depth or value of the Fable work. Give external reviewers the Fable reports, exploit corpus and remediations so their task becomes independent reproduction and challenge rather than a shallow first pass.

## Mandatory repository orientation

From the repository root, read completely:

- `AGENTS.md`
- `README.md`
- `ARCHITECTURE.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `DESIGN.md` if touching UI
- `docs/CASINO-ARCHITECTURE.md`
- `docs/marketplank/SPEC-PLANK-LOCKSTEP-2026-08-27.md`
- `docs/marketplank/DECISION-PLANKCRASH-FAIRNESS-EXECUTION-AND-SAFER-PRESENTATION-2026-08-31.md`
- `docs/marketplank/AUDIT-BRIEF-PLANKCRASH-INDEPENDENT-REVIEW-2026-08-31.md`
- `docs/marketplank/RUNBOOK-PLANKCRASH-INCIDENTS-AND-INTERRUPTED-ROUNDS-2026-08-31.md`
- `docs/marketplank/RUNBOOK-PLANKCRASH-TESTNET-CANARY-2026-08-31.md`
- `scripts/plankcrash-audit-manifest.ts`
- `scripts/plankcrash-launch-gate.ts`
- `scripts/plankcrash-testnet-canary.ts`
- every PlankCrash, PlankBank, Powerboard, drand, rake, burn, progression and settlement contract and test reachable from the architecture document.

Run:

```powershell
git status --short --branch
git log -5 --oneline
npm run plankcrash:launch-gate
```

The gate is expected to fail initially. Preserve its exact blocker output as baseline evidence.

## Workstream A — Freeze and reproduce the review target

1. Confirm the working tree is clean and `dev` matches its remote. Preserve unrelated work.
2. Run the complete repository gates:

```powershell
npm ci
npm run lint:inmotion
npx tsc --noEmit
npm test
npx next build --webpack
```

3. Generate an audit manifest from a clean exact commit:

```powershell
npm run plankcrash:audit-manifest -- --out=plankcrash-audit-manifest-<commit>.json
```

4. Confirm `cleanWorkingTree: true`, the commit is correct, compiler is Solidity `0.8.24`, optimizer runs are `200`, `viaIR` is `true`, and `evmVersion` is `paris`.
5. Create a review bundle containing only tracked source, tests, manifest, architecture/specification documents, generated ABI/bytecode, deployment configuration with secrets removed, and deterministic reproduction instructions.
6. SHA-256 the bundle and record its hash. Never send `.env*`, private keys, database dumps, personal information, production logs containing secrets, or unredacted credentials.

## Workstream B — Independent smart-contract audit

The required scope is defined by `AUDIT-BRIEF-PLANKCRASH-INDEPENDENT-REVIEW-2026-08-31.md`. Expand it into a vendor-ready statement of work including:

- exact target commit and audit-manifest hash;
- all in-scope contracts/libraries/scripts/UI acceptance semantics;
- architectural and economic diagrams;
- privileged-role and key inventory;
- asset/liability flow table;
- trust assumptions and explicitly unresolved randomness/order-fairness tradeoffs;
- required manual review, invariant/property/fuzz testing, exploit reproductions, remediation review and final signed report;
- severity rubric and disclosure channel;
- explicit testing of the public-drand post-reveal lock closure;
- exact deployed testnet bytecode comparison;
- prohibition on treating internal tests as proof of absence of bugs.

Research current reputable auditors from primary sources and recent public reports. Prefer teams with demonstrated Solidity, Arbitrum/Orbit, randomness, gambling/parimutuel accounting, invariant testing and formal-method experience. Produce a comparison matrix covering relevant past work, methodology, scope fit, availability, expected duration, indicative cost only when publicly supported, conflicts, report quality, retest policy and disclosure practice. Do not invent pricing or availability.

Prepare outreach emails and the sanitized review bundle. **Do not hire, pay, sign, or transmit private material without approval.** Once a genuine final report and remediation retest exist:

```powershell
Get-FileHash <final-contract-audit-report> -Algorithm SHA256
```

Record the lowercase 64-hex digest as `PLANKCRASH_EXTERNAL_CONTRACT_AUDIT_SHA256`. Preserve the immutable report, reviewer identity, signature/verification method, delivery timestamp, scope commit and retest report.

## Workstream C — Independent mathematics and mechanism review

Prepare a separate quantitative review package. The reviewer must be organizationally independent from the authors and competent in probability, stochastic processes, pari-mutuel settlement, mechanism design and gambling mathematics.

Require independent reconstruction—without importing the production implementation—of:

- crash inverse-CDF/discretization and maximum-tail behavior;
- expected-value/RTP calculations under the actual routed rake;
- PFSS base return and risk-surplus distribution;
- dilution and all-survive/all-lose/one-survivor cases;
- reserve, vault, founder rake, burn, community and Powerboard flows;
- lottery funding/sealing, founder fee on rollover, reset reserve and higher-base restart;
- ticket/voucher linearity, Sybil splitting, whale concentration and collusion;
- integer rounding, dust, min/max stake and maximum multiplier;
- conservation and solvency across unbounded iterations;
- simulation confidence intervals and adversarial strategies;
- whether UI descriptions exactly match the mathematics.

Require executable independent vectors, sensitivity tables, source notebooks/code, assumptions, limitations and signed final findings bound to the target commit/parameter set. Internal simulations may prepare the package but cannot satisfy independence.

Research qualified academic, actuarial, gaming-lab and specialist reviewers from primary institutional sources. Prepare a vendor/university comparison and outreach drafts. Do not claim engagement until confirmed.

After receiving the genuine final report and remediation review:

```powershell
Get-FileHash <final-mathematics-review-report> -Algorithm SHA256
```

Record the lowercase digest as `PLANKCRASH_EXTERNAL_MATH_REVIEW_SHA256` with immutable supporting artifacts.

## Workstream D — Legal, licensing and compliance approval

Create a jurisdiction decision memo; do not assume “decentralized,” “test credits,” “crypto,” “pari-mutuel,” or “skill” removes gambling/lottery regulation. Describe separately:

- crash game classification;
- lottery/Powerboard classification;
- token, burn, vault and founder-fee treatment;
- operator/interface/provider roles;
- custody and customer-funds treatment;
- geofencing and prohibited jurisdictions;
- age and identity verification;
- KYC/AML, sanctions and source-of-funds obligations;
- responsible-gambling controls, limits, self-exclusion and reality checks;
- advertising, promotions, affiliates and social sharing;
- privacy, retention and breach response;
- consumer disclosures, complaints and dispute resolution;
- taxation and reporting;
- app-store/payment/provider restrictions;
- testnet/private-alpha boundaries.

Research licensed counsel and relevant regulators using official sources. Build a question list and sanitized architecture/economics packet. Prepare engagement and regulator-inquiry drafts. Do not provide a legal conclusion yourself and do not contact a regulator or counsel without owner approval if doing so creates obligations or expense.

A valid `PLANKCRASH_LEGAL_APPROVAL_REFERENCE` must identify a real privileged legal memorandum or counsel approval in the owner’s controlled system, including date, counsel/firm, approved jurisdictions, exact product/version, conditions and expiry/re-review trigger. Store only a non-sensitive reference in environment configuration; never commit privileged advice.

## Workstream E — Execute incident drills

Use Robinhood testnet/private alpha only. Create a dated drill plan with owners, observers, success criteria, recovery-time objectives and evidence locations. Execute and retain evidence for at least:

1. primary RPC outage and fallback-provider disagreement;
2. WebSocket disconnect/reconnect and browser refresh during every round phase;
3. delayed transaction inclusion and unknown receipt reconciliation;
4. duplicate bet/lock submission and nonce/replay handling;
5. sequencer head stall and timestamp jump;
6. beacon due but unrelayed;
7. randomness revealed while derived crash lies later;
8. stale round void and exact carry-forward;
9. keeper/relayer failure and restart without duplicate settlement;
10. local fairness-ledger mismatch/equivocation response;
11. Passenger restart and multiplayer state recovery;
12. compromised operational key tabletop;
13. database degradation without inventing on-chain state;
14. inaccessible/reduced-motion/mobile recovery paths.

Use fault injection or controlled provider blocking; do not attack public infrastructure. Capture UTC timeline, release SHA, chain ID, transaction/block hashes, screenshots, logs, observer sign-off, deviations, corrective issues and rerun outcome. Follow the incident runbook exactly. File every defect with severity and a regression test.

The final `PLANKCRASH_INCIDENT_DRILL_REFERENCE` must point to a real, immutable, owner-controlled drill report with date, commit, participants, scenarios, evidence hashes, findings, remediation commits and approval.

## Workstream F — Establish a real bug-bounty program

Read `SECURITY.md` and inventory scope. Prepare a bounty policy covering:

- exact in-scope domains, repositories, contracts and testnet addresses;
- explicitly out-of-scope production disruption, social engineering, privacy violations, denial of service and attacks on third parties;
- severity taxonomy with concrete smart-contract/game examples;
- safe-harbor language reviewed by counsel;
- confidential submission channel and encryption;
- duplicate/report-quality rules;
- response, triage, remediation and disclosure SLAs;
- reward table funded and approved by the owner;
- KYC/sanctions/tax requirements for payments where applicable;
- embargo and coordinated-disclosure process;
- emergency contact and key rotation;
- program start/end dates and scope-version history.

Research reputable hosted bounty platforms and self-hosted alternatives from their official documentation. Compare custody, fees, researcher reach, triage, safe harbor, private-program support, smart-contract expertise, disclosure workflow and integration. Prepare the policy and launch checklist.

Do not publish the program or promise rewards without owner approval, legal review and committed funding. A valid `PLANKCRASH_BUG_BOUNTY_REFERENCE` must identify an actually active private or public program, not a draft document.

## Workstream G — Produce the signed testnet canary artifact

Official Robinhood testnet is chain ID `46630`, public RPC `https://rpc.testnet.chain.robinhood.com`. The repository canary is read-only by default. A signed artifact requires a dedicated, gas-only, testnet-only key supplied through `PLANKCRASH_CANARY_PRIVATE_KEY`.

Security requirements:

- never reuse a production, treasury, deployer, user or relayer key;
- never print or store the private key;
- store it only in an approved secret manager/repository secret;
- fund only with valueless testnet ETH sufficient for canary gas;
- verify the derived address and chain before signing;
- the canary may send only zero value to its own sender address;
- signed mode must structurally refuse chain `4663` and every chain other than `46630`.

Run:

```powershell
$env:ROBINHOOD_TESTNET_RPC_URL='https://rpc.testnet.chain.robinhood.com'
$env:ROBINHOOD_TESTNET_WS_URL='<standard JSON-RPC websocket provider, optional>'
$env:PLANKCRASH_CANARY_PRIVATE_KEY='<dedicated testnet-only secret>'
$env:PLANKCRASH_CANARY_BLOCKS='8'
npm run plankcrash:canary -- --out=plankcrash-signed-canary-<UTC>-<commit>.json
```

Do not pass Robinhood’s raw Nitro sequencer feed to `ethers.WebSocketProvider`; it is not a standard JSON-RPC WebSocket.

Validate the artifact:

- schema `plankcrash.testnet-canary.v1`;
- chain ID `46630`;
- every assertion true;
- fresh head;
- contiguous parent hashes;
- non-null `signedTransaction`;
- transaction sender equals recipient by construction;
- value is `0`;
- receipt status is successful;
- transaction/block exist on the official testnet explorer;
- artifact contains no secret.

Hash and archive the JSON. Set `PLANKCRASH_TESTNET_CANARY_PATH` to its protected local/CI path when evaluating the launch gate.

## Workstream H — Gate assembly and verification

Only after authentic evidence exists, provide the gate variables through a secure local/CI environment—not committed files:

```text
PLANKCRASH_EXTERNAL_CONTRACT_AUDIT_SHA256=<64 lowercase hex>
PLANKCRASH_EXTERNAL_MATH_REVIEW_SHA256=<64 lowercase hex>
PLANKCRASH_LEGAL_APPROVAL_REFERENCE=<real controlled-system reference>
PLANKCRASH_INCIDENT_DRILL_REFERENCE=<real immutable drill reference>
PLANKCRASH_BUG_BOUNTY_REFERENCE=<active program reference>
PLANKCRASH_TESTNET_CANARY_PATH=<signed artifact path>
```

Run:

```powershell
npm run plankcrash:launch-gate
```

Do not weaken validation to make it pass. Do not replace missing evidence with placeholders. If it fails, report every remaining blocker and its exact owner/next action.

Even a passing gate does **not** authorize deployment. Prepare a final release dossier for explicit owner approval containing:

- exact release commit and clean audit manifest;
- external reports and hashes;
- remediation mapping and retest confirmation;
- legal conditions and approved jurisdictions;
- incident drill report;
- active bounty reference;
- signed canary and explorer links;
- dependency/security status;
- configuration and deployed-bytecode comparison;
- monitoring/rollback/communications plan;
- unresolved risks and recommended exposure caps.

## Required repository validation

For any changes, preserve unrelated work, edit on `dev`, stage explicit paths and run:

```powershell
npm run lint:inmotion
npx tsc --noEmit
npm test
npx next build --webpack
git diff --check
```

Do not push unless authorized by the owner’s standing repository instructions. Never merge to `master` as part of this mission.

## Final response format

Return a concise evidence table:

| Gate | Status | Authentic evidence | Verification | Remaining authority/action |
|---|---|---|---|---|

Then provide:

1. exact commits and files changed;
2. commands/tests executed and results;
3. testnet transaction/block/artifact identifiers;
4. external parties researched/contacted/engaged, carefully distinguishing each state;
5. money, signatures, credentials or owner decisions still required;
6. launch-gate output;
7. explicit statement that no missing evidence was fabricated and no mainnet deployment occurred.

Continue autonomously through every safe, reversible, authorized task. Stop only at genuine external-authority boundaries, and arrive there with the decision packet, drafts, evidence bundle and precise approval request already complete.

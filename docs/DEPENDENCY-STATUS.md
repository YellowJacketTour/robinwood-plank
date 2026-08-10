# Dependency & Supply-Chain Status

**Branch:** `integrate/dev-hh3` (PR [#62](https://github.com/YellowJacketTour/robinwood-plank/pull/62) into `dev`, mergeable)
**Date:** 2026-08-09 → updated 2026-08-10 after the Hardhat 2→3 migration
**Default branch for comparison:** `origin/master` (note: the repo's default branch is `master`, not `main`)

> **§7 item 2 below ("Hardhat 2→3 migration") is no longer a recommendation — it is DONE.**
> This document originally audited `feat/cvi-sota-axiom-1` on Hardhat 2. That branch has since
> been merged with `origin/dev` (which carries Hardhat 3) on `integrate/dev-hh3`, with every real
> toolchain behavioral difference diagnosed and fixed — see PR #62's commit messages. The merge
> changed the whole dependency graph; §1a below re-audits it post-merge. Everything else in this
> document (§2-§6, written pre-merge) is preserved as-is for its historical reasoning, which still
> holds — only the live numbers in §1a supersede §1.

Every number in this document came from a command run against the stated working tree at the
stated time. Commands are quoted so a successor can reproduce them.

---

## 1a. Post-Hardhat-3-merge re-audit (2026-08-10, current)

| Scope | Result |
| --- | --- |
| `npm audit` on `integrate/dev-hh3`, immediately after merging dev | 12 rows (11 low, 0 moderate, **1 high**, 0 critical) |
| The 1 high | `js-yaml` 4.0.0-4.3.0, [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) (quadratic-CPU DoS in `!!omap` resolution) — pulled in fresh by Hardhat 3's `hardhat-toolbox-mocha-ethers` dependency tree, not present pre-merge |
| Fix applied | `npm audit fix` (non-breaking) — bumped `js-yaml` past 4.3.1. **No `overrides` entry needed**, unlike §4's `bn.js`/`diff` pins; npm's own resolver handled it. Lockfile diff: 3 lines. |
| `npm audit` after the fix | **11 rows (11 low, 0 moderate, 0 high, 0 critical)** |
| Vulnerable packages in the **production** dependency graph (`npm ls --omit=dev`) | **0** — every one of the 11 remaining packages checked individually against the runtime tree, confirmed absent |
| Advisories affecting deployed Solidity contract code | **None** — contracts are byte-identical across the entire merge (verified via `git diff --name-only` on every merge/fix commit under `contracts/`); this migration touched only test/build tooling |
| Contract suite after the fix | 913 passing, 0 failing — re-verified independently against the actual committed tree |

**The remaining 11 lows**, all `@ethersproject/*` + `@nomicfoundation/hardhat-ignition*` +
`elliptic`, are the same `elliptic`-rooted cluster §5 below already documents — carried through the
merge essentially unchanged, still dev-only, still unfixable upstream (advisory range `*`, 6.6.1 is
latest). This re-confirms §5's finding rather than superseding it.

---

## 1. Headline (pre-merge baseline, kept for history — see §1a for current numbers)

| Scope | Result |
| --- | --- |
| Vulnerable packages in the **production** dependency graph (`npm ls --omit=dev`) | **0 of 351** |
| Advisories affecting deployed Solidity contract code | **None** |
| `npm audit` on this branch, before this pass | 27 rows (21 low, 6 moderate, 0 high, 0 critical) |
| `npm audit` on this branch, after this pass | **21 rows (21 low, 0 moderate, 0 high, 0 critical)** |
| Distinct root advisories remaining on this branch | **1** (`elliptic`, low, no fixed release exists) |
| Contract suite after the change | see §6 |

---

## 2. Reconciling "GitHub says 13" vs "npm says 27"

These two numbers were never the same measurement. There are **three** independent causes, and
together they account for the gap exactly.

### Cause A — they are measuring different branches

GitHub Dependabot alerts are computed against the **default branch** (`master`). `npm audit` here
runs against **this** branch's `package-lock.json`. The two lockfiles are materially different:
this branch carries an `overrides` block in `package.json` that master does not.

Auditing master's own lockfile in isolation:

```
git show origin/master:package.json      > .auditmaster/package.json
git show origin/master:package-lock.json > .auditmaster/package-lock.json
cd .auditmaster && npm audit --package-lock-only --json
```

produces:

```
{"info":0,"low":13,"moderate":2,"high":3,"critical":0,"total":18}
```

The three HIGH-severity packages on master are `brace-expansion`, `js-yaml`, and `undici`, plus
moderates from `miniflare` and `wrangler`. **None of those appear in this branch's audit at all** —
the `overrides` entries for `brace-expansion@*`, `undici@*` and the `wrangler` bump already
eliminated them here. That is why this branch reports 0 high and master reports high findings.

### Cause B — npm counts *packages*, Dependabot counts *advisories*

`npm audit`'s total is the number of **nodes in the dependency graph that are reachable from a
vulnerability**, including every intermediate dependent. Dependabot's total is the number of
**alerts**, one per (advisory × vulnerable package version) actually present.

On this branch, parsing `npm audit --json` for `via` entries that are advisory objects (rather than
package-name strings) gives:

```
DISTINCT ROOT ADVISORIES ON BRANCH: 3
  moderate bn.js   GHSA-378v-28hj-76wf
  low      diff    GHSA-73rr-hh4g-fpgx
  low      elliptic GHSA-848j-6mx2-7j84
```

So the "27" was **3 real advisories plus 24 packages that merely depend on them** — `hardhat`,
`mocha`, `@nomicfoundation/*`, `@ethersproject/*`, `secp256k1`, `solidity-coverage`, `web3-utils`
and so on are listed as "vulnerable" solely because they transitively pull in one of those three.
They have no advisory of their own.

### Cause C — the 13 alerts decompose cleanly, and they add up

Applying Dependabot's counting rule (one alert per advisory per distinct vulnerable version present)
to master's audit output:

| Advisory | Severity | Vulnerable versions present on master | Alerts |
| --- | --- | --- | --- |
| `brace-expansion` GHSA-mh99-v99m-4gvg | high | 3 (1.x, 2.x, 5.x nodes) | 3 |
| `brace-expansion` GHSA-rgw5-rvv9-x895 | high | 3 (same 3 nodes) | 3 |
| `js-yaml` GHSA-5p4m-2wfm-xmqj | high | 1 | 1 |
| `undici` GHSA-4cwx-7wf7-3272 | high | 1 | 1 |
| **High subtotal** | | | **8** |
| `undici` GHSA-8xcm-r25x-g524 | moderate | 1 | 1 |
| `undici` GHSA-m8rv-5g2x-5cg5 | moderate | 1 | 1 |
| `undici` GHSA-jr45-8vmc-qm54 | moderate | 1 | 1 |
| `undici` GHSA-v3r7-h72x-cjcm | moderate | 1 | 1 |
| **Moderate subtotal** | | | **4** |
| `elliptic` GHSA-848j-6mx2-7j84 **or** `diff` GHSA-73rr-hh4g-fpgx | low | 1 | 1 |
| **Low subtotal** | | | **1** |
| **Total** | | | **13** |

The 8 high and 4 moderate reconcile **exactly** against master's audit output. The single low is
one of the two low advisories master carries (`elliptic` and `diff`/jsdiff); which one GitHub is
surfacing cannot be determined from the CLI alone — the other is presumably dismissed or not
present in GitHub's advisory database with the same range. **This one row is the only part of the
reconciliation that is inferred rather than derived; treat it as such.**

### Summary of the discrepancy

> GitHub's 13 are Dependabot alerts against `master`, which still ships the vulnerable
> `brace-expansion` / `js-yaml` / `undici` versions. npm's 27 were audit graph nodes on
> `feat/cvi-sota-axiom-1`, where those three are already overridden away, and where only **3** real
> advisories existed — the other 24 rows were downstream dependents. **The counts were never
> comparable, and merging this branch into `master` is itself the fix for all 8 high alerts.**

---

## 3. Runtime vs dev exposure

```
npm ls --omit=dev --all --json    # 351 production packages
```

Cross-referencing every package named anywhere in the audit output against that production tree:

```
VULN PKGS PRESENT IN PROD TREE: []
```

**Zero.** Every advisory on this branch lives exclusively in the Hardhat 2.x contract-development
toolchain, which is entirely under `devDependencies`. `npm why elliptic` independently confirms
this, labelling the package `elliptic@6.6.1 dev`.

**No advisory on this branch touches deployed Solidity contract code.** Solidity contracts have no
npm runtime; the only npm package that participates in producing bytecode is `solc`, invoked by
Hardhat, and `solc` carries no advisory here. The vulnerable packages are used at test/compile/
coverage/verification time on developer and CI machines only.

This is a genuinely different risk class from a shipped-code vulnerability, but it is **not zero
risk**: a build-toolchain DoS or crypto weakness still matters if CI processes untrusted input
(e.g. compiling a fork or PR from an outside contributor). It should not be described as "safe",
only as "not reachable from production or from on-chain code".

---

## 4. What was fixed in this pass

`npm audit fix` (non-breaking) was re-run and is a **no-op** — it changed neither `package.json`
nor `package-lock.json`, because every remaining fix npm knows about is semver-major
(Hardhat 2 → 3, hardhat-toolbox 6 → 7, mocha downgrade). Those were explicitly out of scope.

Two targeted `overrides` entries were added instead:

```json
"bn.js@4.11.6": "4.12.5",
"diff@7.0.0":  "8.0.4"
```

- **`bn.js` 4.11.6 → 4.12.5** resolves GHSA-378v-28hj-76wf (moderate, infinite loop). Stays within
  the 4.x line, so `ethjs-unit` / `number-to-bn` / `web3-utils` see a compatible API. Version-pinned
  so the unrelated `bn.js@5.2.5` in the tree is untouched.
- **`diff` 7.0.0 → 8.0.4** resolves GHSA-73rr-hh4g-fpgx (low, jsdiff parsePatch DoS) in mocha's
  reporter. This is a major bump of a transitive package, so it was verified against the full
  contract suite (§6) — mocha's diff output is exercised by every assertion failure path.

Result: `{"low":21,"moderate":0,"high":0,"critical":0,"total":21}`, down from 27, with root
advisories down from 3 to 1.

---

## 5. Remaining advisories

Only **one** root advisory remains. The other 20 rows are its dependents and carry no advisory of
their own.

| Severity | Package | Advisory | Dev-only or runtime? | Fixed? | Why |
| --- | --- | --- | --- | --- | --- |
| low | `elliptic` @6.6.1 | [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84) — risky cryptographic primitive | **dev-only** (`npm why` reports `dev`) | **No — not fixable** | Advisory range is `*` and 6.6.1 is the **latest published version**. No upstream fix exists at any version. Reached only via `@ethersproject/signing-key` ← `@nomicfoundation/hardhat-verify` ← `hardhat-ignition`, i.e. the Etherscan-verification path. Not used for signing anything with real value. |

The following 20 packages appear in `npm audit` output **only** because they depend on `elliptic`;
none has its own advisory, and none is in the production tree:

`@ethersproject/abi`, `@ethersproject/abstract-provider`, `@ethersproject/abstract-signer`,
`@ethersproject/hash`, `@ethersproject/signing-key`, `@ethersproject/transactions`,
`@nomicfoundation/hardhat-chai-matchers`, `@nomicfoundation/hardhat-ethers`,
`@nomicfoundation/hardhat-ignition`, `@nomicfoundation/hardhat-ignition-ethers`,
`@nomicfoundation/hardhat-network-helpers`, `@nomicfoundation/hardhat-toolbox`,
`@nomicfoundation/hardhat-verify`, `@typechain/hardhat`, `ethereum-cryptography`,
`ethereumjs-util`, `hardhat`, `hardhat-gas-reporter`, `mocha`, `secp256k1`, `solidity-coverage`.

They will all clear the moment `elliptic` ships a fix or the toolchain moves off ethers v5.

---

## 6. Regression verification

The full contract suite was run after the dependency change, using the project script (never bare
`npx hardhat test`, which picks the wrong tsconfig):

```
npm run test:contracts
# -> cross-env TS_NODE_PROJECT=tsconfig.hardhat.json hardhat test
```

**Observed: 913 passing, 0 failing** — matching the pre-change baseline exactly. No regression.

---

## 7. Recommended path for whoever takes over

1. **Merge PR #62 (`integrate/dev-hh3`) into `dev` (highest value, lowest effort).** This already
   *is* the merge with `dev`/`master`'s lineage that clears the `brace-expansion`/`js-yaml`/`undici`
   Dependabot alerts on `master` — confirm after merging that Dependabot re-scans and drops to the
   ~1 low `elliptic` finding.

2. ~~Hardhat 2 → 3 migration~~ **DONE.** Completed on `integrate/dev-hh3` (PR #62): real config,
   ESM, and gas-estimation-behavior differences diagnosed and fixed per-issue rather than papered
   over — see PR #62's commit messages for the full list. 913 passing / 0 failing, verified against
   the committed tree, matching the pre-migration Hardhat 2 baseline exactly. The `mocha` vs
   `node:test` concern this item originally raised did not materialize — `hardhat-toolbox-mocha-
   ethers` keeps mocha as the runner under Hardhat 3.

3. **`elliptic` needs no action now.** It is dev-only, unfixable upstream, and low severity. Track
   the advisory; it resolves itself when ethers v5 is out of the tree.

4. **Prune the `overrides` block periodically.** It has grown to ~20 entries, several of them
   version-pinned (`brace-expansion@5.0.7`, `undici@7.28.0`, and now `bn.js@4.11.6`,
   `diff@7.0.0`). Version-pinned overrides silently stop applying when the underlying package
   moves, so they need re-checking after any major dependency bump. Re-run `npm audit` after every
   `npm update` and delete entries that no longer match anything.

5. **Do not describe this project as free of vulnerabilities.** The accurate statement is: *no
   advisory reaches production code or deployed contracts; one unfixable low-severity dev-toolchain
   advisory remains.*

---

## Reproduction commands

```bash
npm audit --json                      # this branch
npm ls --omit=dev --all --json        # production graph (351 pkgs, 0 vulnerable)
npm why elliptic                      # confirms dev-only
npm run test:contracts                # 913 passing / 0 failing

# default-branch comparison
mkdir -p .auditmaster
git show origin/master:package.json      > .auditmaster/package.json
git show origin/master:package-lock.json > .auditmaster/package-lock.json
(cd .auditmaster && npm audit --package-lock-only --json)
```

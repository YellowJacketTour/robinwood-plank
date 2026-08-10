# Dependency & Supply-Chain Status

**Branch:** `feat/cvi-sota-axiom-1`
**Date:** 2026-08-09
**Default branch for comparison:** `origin/master` (note: the repo's default branch is `master`, not `main`)

Every number in this document came from a command run against this working tree. Commands are
quoted so a successor can reproduce them.

---

## 1. Headline

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

1. **Merge this branch to `master` (highest value, lowest effort).** All 8 high and 4 moderate
   Dependabot alerts come from `brace-expansion`, `js-yaml` and `undici` versions that this
   branch's `overrides` block already eliminates. This is the single action that clears the GitHub
   alert banner. Confirm afterwards that Dependabot re-scans and drops to ~1 low.

2. **Hardhat 2 → 3 migration — scope it as its own project, not a dependency chore.** `npm audit`
   points at `hardhat@3.12.0` / `@nomicfoundation/hardhat-toolbox@7.0.0` as the fix for the whole
   remaining cluster. This is a breaking change to the config format, plugin API, and test runner
   (Hardhat 3 defaults to `node:test`, not mocha) and would put all 913 contract tests at risk.
   Do **not** run `npm audit fix --force`. Budget it as a standalone branch with the full suite as
   the acceptance gate. Note that master's audit already shows
   `@nomicfoundation/hardhat-toolbox-mocha-ethers`, suggesting a partial migration exists elsewhere
   in the repo's history worth reviewing first.

3. **`elliptic` needs no action now.** It is dev-only, unfixable upstream, and low severity. Track
   the advisory; it resolves itself when ethers v5 is out of the tree (which Hardhat 3 does).

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

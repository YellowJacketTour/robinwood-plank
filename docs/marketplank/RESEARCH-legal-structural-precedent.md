# Securities-law structural precedent — research notes

**NOT LEGAL ADVICE.** This is informational research only, compiled to
help brief actual securities counsel before the Global Index revenue-share
token (`SPEC-PLANK-CHECKS-AND-INDEX.md` §2) goes anywhere near mainnet.
Nothing below substitutes for a licensed securities attorney reviewing the
actual mechanism, code, and marketing copy before any launch decision.

## 1. What the real cases actually turned on

- **SEC v. Ripple** (SDNY, July 2023, Judge Torres): split ruling.
  Institutional Sales (direct contracts, $728M) = securities — buyers
  reasonably expected Ripple's efforts to drive price. Programmatic Sales
  on blind exchanges ($757M) = not securities — buyers couldn't know if
  proceeds went to Ripple or a third party, breaking the "efforts of
  others" link. **Lesson: counterparty blindness and distribution
  channel, not the token itself, changed the outcome.**
- **SEC v. Terraform Labs / Do Kwon** (SDNY, Judge Rakoff, Dec 2023
  summary judgment + April 2024 jury verdict): UST, LUNA, wLUNA, MIR all
  held securities under Howey, including a stablecoin combined with a
  yield protocol (Anchor). The jury separately found fraud — Kwon and
  Terraform misrepresented that UST's peg "self-healed" algorithmically
  when it actually depended on continuous institutional trading support.
  $4.5B judgment. **Lesson: misrepresenting the mechanism's autonomy is an
  independent, severe liability layer beyond the registration question —
  directly relevant to how any marketing copy describes the Global
  Index's NAV/redemption mechanics.**
- **SEC v. Coinbase** (staking-as-a-service claim): dismissed entirely in
  Feb 2025 following formation of the SEC's Crypto Task Force (Jan 2025).
  The dismissal was posture-driven (prosecutorial discretion under new
  leadership), not a merits ruling that staking pools are categorically
  exempt. No binding precedent was created.
- **SEC v. LBRY** (D.N.H. 2022): the LBC token was held a security at the
  initial-offering stage; LBRY lost, was fined $111,614, then wound down
  and dropped its First Circuit appeal — so no appellate clarification
  ever issued despite early hopes it would mirror Ripple's outcome.
- **Uniswap Labs**: received a Wells notice (April 2024) alleging
  unregistered exchange/broker/securities activity; the SEC closed the
  investigation with no enforcement action in Feb 2025 — again a
  prosecutorial-discretion outcome under new leadership, not a court
  ruling establishing that AMM fee-generating LP positions are
  non-securities. No binding Compound/Aave-style fee-share precedent
  exists either way.

## 2. Regulatory posture, 2025-2026

Real, documented shift: the SEC Crypto Task Force stood up in Jan 2025;
Chair Atkins has directed staff toward a conditional "innovation
exemption"/"Regulation Crypto Assets" framework, tracing back to
Commissioner Peirce's 2020 Token Safe Harbor proposal (reissued as "Safe
Harbor 2.0"). As of mid-2026 reporting, Peirce herself has indicated the
innovation exemption's likely initial scope is **tokenized equities**, not
fee-share DeFi tokens generally — and no formal rule has been finalized.

**Net assessment:** friendlier enforcement discretion (the Coinbase
dismissal, the Uniswap no-action outcome) and an active rulemaking track,
but **no published rule or safe harbor yet directly covers a protocol-
revenue-share vault token.** It remains case-by-case, now filtered through
a more permissive prosecutorial posture — not new binding law.

## 3. Structural levers that actually mattered in real precedent

- **Distribution/counterparty structure** was outcome-determinative in
  Ripple — blind secondary-market sales (no securities finding) vs. direct
  sales with promises attached (securities finding).
- **Marketing/promotional claims about the mechanism's autonomy** were
  independently fatal in Terraform, as a fraud finding separate from the
  registration question entirely.
- **"Sufficient decentralization" has never been successfully argued to a
  final judgment** in a fully litigated crypto case — LBRY's appeal
  (which might have tested this) was withdrawn; Uniswap's and Coinbase's
  favorable outcomes were discretionary dismissals, not adjudicated
  decentralization standards a future project can cite as a legal test.
- **No case establishes that a revenue-share token can categorically avoid
  Howey.** The consistent real-world pattern across every case reviewed is
  **risk management, not risk elimination** — non-custodial mechanics,
  permissionless secondary trading, and disciplined marketing reduce
  exposure but do not create a court-tested exemption.

## 4. What this means for the Global Index token specifically

The design already in `SPEC-PLANK-CHECKS-AND-INDEX.md` §2.7-§2.9 leans
toward the structural mitigants real precedent actually validates:
non-custodial (zero privileged withdrawal path over pooled reserves,
§2.8), mechanical/usage-based yield rather than discretionary managerial
allocation, and permissionless secondary trading. None of that changes the
bottom line: **real securities counsel must review the final mechanism,
distribution plan, and every piece of marketing copy before launch** —
Terraform's fraud liability specifically shows that *how the mechanism is
described*, not just how it's built, is independently load-bearing.

---

**Again: NOT LEGAL ADVICE.** This document exists to make the eventual
conversation with real counsel faster and better-informed, not to replace
it.

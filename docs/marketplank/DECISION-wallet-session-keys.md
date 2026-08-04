# Session-key / paymaster provider comparison — for the admin's decision

This is a decision-support document, not a decision — the choice of
provider is yours to make. Goal: session keys (one signature grants a
scoped, expiring key for low-value repeat actions like listings/point-
claims) plus a paymaster (gasless sponsorship for those actions),
reserving full wallet confirmations for high-value actions only.

## The filter that matters most: does it actually support Robinhood Chain (id 4663)?

Robinhood Chain is a newer, smaller EVM chain — not Ethereum mainnet or a
top-tier L2 — so the first cut is simply "does this vendor treat the chain
as first-class, or would we be fighting an unsupported integration."

**Eliminated:**
- **Coinbase Smart Wallet / Base paymaster** — Coinbase's own CDP
  paymaster is Base-only. Off-Base chains would need a generic
  ERC-7677-compliant third-party paymaster anyway, meaning we'd still
  need one of the providers below as the real backbone. Not a real
  option here.
- **Privy** (acquired by Stripe, June 2025) — native gas sponsorship is a
  real, recently-shipped feature, but built around a fixed set of chains
  Privy operationalizes itself; no evidence of Robinhood Chain support or
  a self-serve "add my chain" path. Best treated as an embedded-wallet/
  auth layer, not the AA/paymaster backbone.

**Survive the filter:**
- **Alchemy** (Account Kit + Gas Manager) and **ZeroDev** (Kernel) — and
  this is the single strongest data point in the whole comparison:
  **Robinhood Chain's own documentation names Alchemy as the chain's
  primary AA provider, with ZeroDev listed as the alternative.** The
  chain team has already integrated both.
- **Pimlico** — the open-source Alto bundler covers ~40 EVM chains and is
  genuinely self-hostable (bundler + paymaster contracts), so even
  without pre-listed Robinhood Chain support, standing up an own instance
  is a real, low-lock-in option.
- **Biconomy** — chain-agnostic architecture, but the hosted paymaster/
  bundler service maintains its own supported-chains list; Robinhood
  Chain support would likely need a support request, similar to Alchemy.
- **thirdweb** — broad chain-agnostic AA stack, no evidence of specific
  Robinhood Chain integration yet.
- **Turnkey / Dynamic / Fireblocks** — these are signer/key-management
  and embedded-wallet infra, not bundler/paymaster providers. Relevant
  only as a complementary auth layer, not a substitute for the AA stack.

## Comparing the survivors

| | Chain support | Session keys | Pricing | Reliability/scale | Next.js integration |
|---|---|---|---|---|---|
| **Alchemy** | Already live on Robinhood Chain per chain docs; broadest "enterprise-onboarded" chain list | Solid via Modular Account/permission validators; not as fine-grained as ZeroDev out of the box | Gas Manager: usage-based + tiered plans, hosted-only | Large-scale, well-established RPC + AA provider; no major public 2025-26 incidents found (not independently verified) | Best-documented Next.js/React SDKs (Account Kit), lowest integration friction |
| **ZeroDev** | Also named directly in Robinhood Chain docs; 30+ chains, acquired by Offchain Labs (Aug 2025) | **First-class, most granular** primitive — "Permissions" system supports per-key, per-contract, per-function, time/amount-scoped policies, purpose-built for exactly this use case | Usage-based hosted plans; Kernel contracts are open-source and self-hostable, hosted service is the practical path | Post-acquisition scale untested; smaller org than Alchemy | Good docs, slightly more setup than Alchemy, purpose-built session-key examples |
| **Pimlico** | Widest raw chain count; genuinely self-hostable (Alto is OSS) — lowest lock-in risk | Bolted on via ERC-7579 modules (e.g. Kernel, Safe7579) rather than a first-party primitive — quality depends on the paired modular account | Transparent: hosted = actual gas cost + ~10% surcharge (stacks with bundler fee, ~15.5% combined); or self-host for near-zero markup | OSS/dev-focused, smaller commercial footprint, less public incident transparency either way | Requires pairing with a separate smart-account SDK — more assembly than Alchemy/ZeroDev's turnkey kits |
| **Biconomy** | Chain-agnostic architecture, but Robinhood Chain support on the hosted service is unconfirmed | Native "Session Validation Modules" — established, reasonably granular, used in production for gaming/agent use cases | Modular Smart Account works with any paymaster; also runs its own hosted Verifying/Token Paymaster | Long-running provider, broad past production usage, less 2025-26 press than Alchemy/ZeroDev | Moderate; SDK is comprehensive but docs are fragmented (legacy vs current) |

## Recommendation (for you to weigh — not a decision already made)

Given the chain-support constraint, Alchemy and ZeroDev deserve the most
weight simply because Robinhood Chain's own team already integrated them
— that removes the single biggest risk (a vendor treating the chain as
second-class or unsupported). Between the two, **ZeroDev looks like the
better fit for the specific session-key ask** — its Kernel "Permissions"
system is a first-class primitive built for exactly "a scoped, expiring
key for low-value repeat actions," where Alchemy's session-key support is
more general-purpose.

A pragmatic path, if useful: prototype with **ZeroDev** for session-key
granularity, keep **Alchemy Gas Manager** in reserve given its chain-
native status and Next.js SDK maturity, and treat **Pimlico self-hosting**
as the de-risking fallback if either hosted vendor's Robinhood Chain
support proves shallow in practice.

This still needs your final call — cost tolerance, how much vendor
assembly work you want to take on, and how much weight to put on "the
chain team already picked these two" are all judgment calls only you can
make.

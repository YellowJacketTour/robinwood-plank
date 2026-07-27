# RobinWood ($PLANK) — plank.love

Official site for the RobinWood NFT collection and $PLANK on **Robinhood Chain**
(chain ID `4663`). Next.js App Router, TypeScript, Tailwind CSS, ethers, and an
official Uniswap-routed trade widget.

## Run locally

```bash
npm install
# Create .env.local (see env table below)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

```bash
npm run build
npm run start
```

## Environment

| Variable | Public? | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_TRADE_OPENS_AT` | Yes | ISO 8601 UTC when the official trade widget unlocks. **4:20 PM Central 2026-07-25** = `2026-07-25T21:20:00.000Z` |
| `NEXT_PUBLIC_RULES_RELAXED` | Yes | `true` only after anti-sniper/limits off. While `false`: official widget only |
| `UNISWAP_API_KEY` | **Server only** | In-widget quote + swap + **0.42069%** site fee |
| `NEXT_PUBLIC_MINT_START_AT` | Yes | Optional mint countdown target |

### Site fee (hard-coded)

| | |
| --- | --- |
| **Fee** | `0.42069%` (`42.069` bps) |
| **Recipient** | `0xfa987d386c4f61b27cb67a1e4e1239866fe8d9ba` |
| **When** | Official plank.love widget swaps only |

## Trade launch model

1. Site timer hard-locks the widget until open.
2. LP may go live ~30 minutes earlier as a sniper trap — community waits for plank.love.
3. Early buyers hit on-chain Plank List / anti-sniper controls.
4. After open + rules relaxed: free trading; LP renounced / burned.

## Security (keys & fee)

| Secret / control | How protected |
| --- | --- |
| `UNISWAP_API_KEY` | Server-only env. Never in request body or client JSON. |
| Site fee | Hard-coded `SITE_FEE`. Server injects `integratorFee` on every quote. |
| Venue | No Uniswap.app deep-links until `NEXT_PUBLIC_RULES_RELAXED=true`. |

`.env*` is gitignored.

## Marketplank (NFT marketplace, `/market`)

Built on **Seaport 1.6**, which is already deployed and verified on Robinhood
Chain at its canonical address — we integrate with the audited bytecode rather
than forking or redeploying it.

| Env var | Public? | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_MARKET_ENABLED` | Yes | **Master gate.** `false`/unset renders only the status page. Do not flip without the audit below. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | **Server only** | Durable order-relay storage (Upstash/Vercel KV). Falls back to an ephemeral file store when unset. |
| `NEXT_PUBLIC_MARKET_VAULT_ADDRESS` | Yes | Phase 2 liquidity vault. Unset until deployed **and audited**. |

**Fees:** `$PLANK`/RobinWood trades are permanently **0%**. Other approved
collections default to 0.5%, toggleable per collection in
`lib/market/collections.ts`. Fees accrue in ETH to
`0xcdb7ca36d35fa16d15fda859a46f1d72d979e9d8` and fund the vault's seed
liquidity — no second token, no owner capital required.

**Bids are WETH**, not native ETH (`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`,
verified by RPC). Seaport cannot pull native ETH from an offerer, so an
ETH-denominated bid could never fill. Several impostor contracts on this chain
also report the symbol `WETH` — never resolve it by symbol lookup.

### Security posture

Every displayed order field is **derived from the signed order itself**
(`lib/market/order-validation.ts`), in the API *and* independently in the
buyer's browser. A marketplace that trusts client-supplied prices can show one
number and have the wallet sign another; this makes that impossible by
construction.

- `docs/marketplank/SPEC.md` — architecture and go-live gates
- `docs/marketplank/AUDIT-2026-07-27.md` — 10 findings (2 critical, 4 high), all fixed and pinned by regression tests

**The vault contract is not third-party audited and is not deployed.** That
gate is unchanged.

### Tests

```bash
npm test              # both suites
npm run test:market   # order validation (attack regressions)
npm run test:contracts # vault + audit regressions
```

## Deploy (Vercel)

1. Import the repo.
2. Set env vars in the dashboard (not in git).
3. Deploy.

## Notes

- Not financial advice. Always verify the contract address.
- Official CA: `0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc`

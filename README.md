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

## Deploy (Vercel)

1. Import the repo.
2. Set env vars in the dashboard (not in git).
3. Deploy.

## Notes

- Not financial advice. Always verify the contract address.
- Official CA: `0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc`

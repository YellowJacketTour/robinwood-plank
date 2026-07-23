# RobinWood ($PLANK)

Official site and mint interface for the RobinWood NFT collection and $PLANK
on Robinhood Chain. Built with the Next.js App Router, TypeScript, Tailwind CSS,
and ethers.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

To verify a production build (this is what Vercel runs):

```bash
npm run build
npm run start
```

## Project structure

- `app/layout.tsx` — root layout, fonts (`next/font/google`: Rye for display,
  Work Sans for body), and page metadata/OG tags.
- `app/page.tsx` — assembles the single-page layout.
- `public/plank-social.jpg` — static Open Graph and X link-preview artwork.
- `components/MintPanel.tsx` — live NFT contract reads, wallet connection, and
  free, allowlist, and paid mint transactions.
- `components/` — site sections including `Nav`, `Hero`, `MintInfo`,
  `Distribution`, `Roadmap`, `LiquidityBurn`, and `Footer`.
- `lib/mint-contract.ts` — NFT contract ABI, address, and Robinhood Chain
  configuration.
- `lib/constants.ts` — $PLANK token address, navigation, and social links.

## Deploy to Vercel

1. Push this project to a GitHub repository.
2. Go to [vercel.com/new](https://vercel.com/new) and import the repository.
3. Vercel auto-detects Next.js — no build settings need to change
   (`npm run build`, output handled automatically).
4. Click **Deploy**. You'll get a `*.vercel.app` URL immediately.

## Point a purchased domain at Vercel

1. In the Vercel dashboard, open your project → **Settings → Domains** and add
   your domain.
2. Vercel will show you the exact records to add. As of this writing, for a
   domain purchased at Namecheap, Porkbun, or similar, that's typically:

   **Root domain** — add an `A` record:

   | Type | Host/Name | Value           | TTL       |
   | ---- | --------- | --------------- | --------- |
   | A    | `@`       | `76.76.21.21`   | Automatic |

   **`www` subdomain** — add a `CNAME` record:

   | Type  | Host/Name | Value                | TTL       |
   | ----- | --------- | -------------------- | --------- |
   | CNAME | `www`     | `cname.vercel-dns.com` | Automatic |

   Always confirm the exact values in your Vercel project's Domains panel —
   Vercel will flag the specific record it expects for your domain and warn
   you if anything doesn't match yet.

3. In your registrar's DNS settings (Namecheap: Domain List → Manage → Advanced
   DNS; Porkbun: Domain Management → DNS Records), add the records above.
   Remove any conflicting `A`/`CNAME`/parking records for the same host first.
4. DNS propagation can take anywhere from a few minutes to a few hours.
   Vercel's Domains panel will show a green checkmark once it verifies the
   domain and provisions an SSL certificate automatically.
5. Optional: set your apex domain to redirect to `www` (or vice versa) from
   the same Domains panel.

## Mint configuration

- The NFT contract is deployed on Robinhood Chain at
  `0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156`.
- The site uses Robinhood Chain's public RPC by default. Set
  `NEXT_PUBLIC_ROBINHOOD_RPC_URL` in Vercel to use a production RPC provider.
- Set `NEXT_PUBLIC_MINT_START_AT` to an ISO 8601 timestamp to show the homepage
  countdown, for example `2026-08-01T19:00:00-05:00`. Leave it unset to hide
  the countdown.
- Allowlist minting reads `public/proofs.json`. Publish proofs keyed by
  lowercase wallet address before opening the allowlist phase.

# RobinWood ($PLANK)

Marketing site for the RobinWood NFT collection and $PLANK meme coin, launching
on the (fictional) Robinhood Chain. Static, single-page, no backend, no
wallet-connect — built with Next.js 14+ App Router, TypeScript, and Tailwind
CSS.

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
- `app/opengraph-image.tsx` — auto-generated OG/Twitter share image via
  `next/og` (no static image asset needed).
- `components/` — `Nav`, `Hero`, `MintInfo`, `Distribution`, `Roadmap`,
  `Footer`, `CopyCA` (contract-address copy button), `PlankMascot` (placeholder
  SVG art), `Reveal` (scroll-in animation wrapper).
- `lib/constants.ts` — contract address, nav links, and social link
  placeholders (update `SOCIAL_LINKS` before launch — currently `#`).

## Deploy to Vercel

1. Push this project to a GitHub repository.
2. Go to [vercel.com/new](https://vercel.com/new) and import the repository.
3. Vercel auto-detects Next.js — no build settings need to change
   (`npm run build`, output handled automatically).
4. Click **Deploy**. You'll get a `*.vercel.app` URL immediately.

## Point a purchased domain (e.g. `plank.lol`) at Vercel

1. In the Vercel dashboard, open your project → **Settings → Domains** and add
   your domain (e.g. `plank.lol` and/or `www.plank.lol`).
2. Vercel will show you the exact records to add. As of this writing, for a
   domain purchased at Namecheap, Porkbun, or similar, that's typically:

   **Root domain (`plank.lol`)** — add an `A` record:

   | Type | Host/Name | Value           | TTL       |
   | ---- | --------- | --------------- | --------- |
   | A    | `@`       | `76.76.21.21`   | Automatic |

   **`www` subdomain (`www.plank.lol`)** — add a `CNAME` record:

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

## Notes

- This is an info-only marketing site: there is no whitelist backend, no
  wallet connection, and no mint transaction wired up. The "Join the
  Whitelist" button anchors to a placeholder section on the page.
- Social links in `components/Footer.tsx` / `lib/constants.ts` are placeholder
  `#` hrefs — replace with real URLs before launch.
- `components/PlankMascot.tsx` is a hand-rolled SVG placeholder standing in
  for commissioned mascot artwork.

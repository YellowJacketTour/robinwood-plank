# Marketplank Multichain — Master One-Shot Handoff

**Written:** 2026-08-19 · **Branch:** `feat/marketplank-multichain-index` · **Vessel:** PR #94 → `dev`

This document is the canonical, self-contained state of the multichain marketplace build.
It exists so a session with zero prior context can resume without losing anything.
Everything below was verified by reading real files, real git history, real API responses,
and real on-chain transactions — not recalled from memory.

---

## 1. What this project is

RobinWood (`$PLANK`) is an NFT collection and app on **Robinhood Chain (chainId 4663)**.
`Marketplank` is its marketplace: a Seaport-based order book plus a multi-vault Instant Swap.

**The multichain thesis (what this branch builds):** Marketplank becomes an
*any-chain, any-collection* marketplace. Users browse and trade NFTs across 11 chain
surfaces from one UI, and — critically — **list natively with Marketplank on foreign chains
at 1.8%** instead of only being able to fill OpenSea's own orders at OpenSea's ~2.5% cut.

The fact that makes this tractable without deploying anything new: **Seaport 1.6 is deployed
at the identical canonical address `0x0000000000000068F116a894984e2DB1123eB395` on Robinhood
Chain and all 7 foreign EVM chains** (live-verified via `eth_getCode`). So native listing
generalizes to a chain *parameter* — no new marketplace contracts, no new deploy authorization.

---

## 2. Chain coverage (11 surfaces)

| Surface | chainId | Mechanism | State |
|---|---|---|---|
| Robinhood Chain (home) | 4663 | Seaport, native | Live |
| Ethereum | 1 | Seaport | Live |
| Polygon | 137 | Seaport | Live |
| Arbitrum | 42161 | Seaport | Live |
| Base | 8453 | Seaport | Live |
| Optimism | 10 | Seaport | Live |
| BNB Chain | 56 | Seaport | Live |
| Avalanche | 43114 | Seaport | Live, **0 collections discovered** (see §7) |
| zkSync Era | 324 | Seaport, native-only | OpenSea does not index it |
| Solana | — | Magic Eden M2 | Read live; **write-path unproven** |
| Bitcoin Ordinals | — | UniSat + native PSBT engine | **Testnet4 proven; mainnet gated** |

Registries: `lib/market/multichain/trading/foreign-chain-registry.ts`,
`lib/market/multichain/trading/non-evm-chains.ts`.

---

## 3. Fee architecture (`lib/constants.ts`)

| Constant | Value | Applies to |
|---|---|---|
| `MARKET_DEFAULT_FEE_BPS` | `50` (0.5%) | Robinhood-chain collections with no override |
| `MARKETPLANK_NATIVE_LISTING_FEE_BPS` | `180` (1.8%) | Marketplank-native listings on foreign chains |
| `MARKETPLANK_SWAP_FEE_BPS` | `180` (1.8%) | Native swap orders |
| `MARKETPLANK_FOREIGN_FILL_TIP_BPS` | `180` (1.8%) | Fulfiller tip on third-party (OpenSea) order fills |
| `MARKETPLANK_FOREIGN_OFFER_FEE_BPS` | `180` (1.8%) | Foreign-chain offers |

> **Trap — do not "simplify" this.** `FOREIGN_FEE_BPS = 180` in
> `foreign-chain-registry.ts` is *also* 180 but is a **separate, display-only** constant tied
> to the **undeployed** fee-router contract. The code comments explicitly warn against
> aliasing it to the live fee constants. Five constants sharing a value is intentional,
> not duplication.

Fees are captured via Seaport **tips / `additionalRecipients`** on the fill, and on the
offer side too (an offer-side gap was found and closed this session).

---

## 4. Built and PROVEN

- **Multichain collection index** — 1,768 real collections across 9 chain families in
  Postgres right now; `/api/market/multichain` returns them with real names/images/contracts.
- **Native Bitcoin Ordinals listing engine** (`lib/market/multichain/trading/native-bitcoin-listing.ts`)
  — OpenOrdex-style PSBT protocol, `SIGHASH_SINGLE|ANYONECANPAY` seller leg, dummy-UTXO
  sat-preservation. **Proven end-to-end on live Bitcoin testnet4** with a real UniSat browser
  extension: real inscription listed, real second wallet bought it, transaction verified
  byte-exact on-chain. Not a unit test — a real settled trade.
- **Foreign-chain native listing** — Seaport chain-parameterized; migration `019` added
  `chain_slug`/`chain_id` to `market_orders`.
- **TypeScript is clean** — `npx tsc --noEmit` exits 0 with no output.
- **Tests** — 622 market tests + 282 contract tests passing per PR #94's checklist.

### Real UniSat API quirks discovered live (do not regress these)
1. `toSignInputs` entries **must** include `address` — otherwise
   `"no address or public key in toSignInput"`.
2. Non-default sighash types **must** be whitelisted via an explicit
   `sighashTypes: [131]` array — otherwise `"Sighash type is not allowed"`.
3. Wallet providers reject with plain `{code, message}` objects, **not** `Error` instances —
   hence the `errorMessage(e, fallback)` helper. Never use `e instanceof Error` alone here.

### Security fixes shipped this session (Bitcoin engine)
- `MINIMUM_LISTING_PRICE_SATS = 30,334` — dust guard. Found by a **real Bitcoin Core
  rejection** (`dust, tx with dust output must be 0-fee`): 1.8% of a 15,000-sat listing is
  270 sats, below the 546-sat dust threshold.
- Broadcast route now **decodes the extracted transaction** and asserts it spends the
  listing's UTXO, pays the seller exactly `priceSats`, and pays the fee recipient at least
  the expected fee — *before* broadcasting.
- `GET /api/market/multichain/native-bitcoin-listings` **strips `sellerPsbtBase64`**
  (public leak enabled off-platform, fee-free fulfillment).
- `POST` does **real BIP-341 Schnorr verification** via `psbt.validateSignaturesOfInput`
  plus an exact-sighash check — previously it only checked the field was non-empty.
- Buyer's dummy UTXO now runs the **same inscription/Rune safety filter** as payment UTXOs.
- `putNativeBitcoinListing` uses `ON CONFLICT (id) DO UPDATE ... WHERE status != 'active'`.

---

## 5. Built but NOT proven / gated off

| Item | Gate | To unblock |
|---|---|---|
| Bitcoin **mainnet** trading | `NATIVE_BITCOIN_MAINNET_ENABLED` — **not set anywhere** | Deliberate. Set only when real BTC risk is accepted. All real-money BTC paths share this one switch (`native-bitcoin-listing.ts`, `bitcoin-utxo-safety.ts`, `unisat-ordinals-trade.ts`). |
| `MarketplankForeignFeeRouter.sol` | **Undeployed** (registry address `null`) | `foreign-fulfill.ts` was already rewired **off** this dead router onto direct Seaport + fulfiller tip. Deploy only if the router mechanism is actually wanted. |
| `MarketplankAcrossReceiver.sol` | **Undeployed** | Across has no live route configured. |
| `MarketplankDeBridgeExecutor.sol` | **Undeployed** | Same. |
| Solana buy/sell/offer **write path** | `MAGICEDEN_API_KEY` — **absent from `.env.local`** | Owner was "waiting on Magic Eden to send API keys." Read-only Solana works keyless. Fails closed with a clear error, never fabricated data. |
| PlankCrash casino contracts | In PR #94 but **not deployed to any chain** | Includes the CRITICAL `presetCashOut` exploit fix. |
| PlankDerby | Deliberately **excluded** from PR (`7c6f5da`) | "untested, not ready for dev" |
| DefiLlama adapter | Ethereum-mainnet only, **no volume field** | Floor-price ranking only. Volume comes from the app's own `evm-log-scan.ts` activity ranking. |
| Robinhood-Chain browse-only UI gap | — | Noted by the architecture audit. |

**Known discovery-scanner limitations (documented in-code, not bugs to "discover" again):**
10-block-per-tick Alchemy scan cap; cursor-persistence bug; bytes4 padding bug.

---

## 6. The one hard blocker: CI

`gh pr checks 94` → **`build` and `Dependency health` both FAIL in ~3 seconds.**

This is the **GitHub Actions billing block** — the org has no payment method on file.
It is **not a code defect**. Every real job dies instantly; deploy/relayer/allowlist jobs
then skip.

**Two things to know:**
1. Only the owner can fix it (add a payment method to the GitHub org). Not self-serve.
2. **The usual "flip the repo public to get free Actions minutes" workaround is FORBIDDEN
   here.** Standing policy: never make `robinwood-plank` public while multichain/unreleased
   work exists on any branch — GitHub visibility is repo-wide, not branch-scoped, so
   flipping it would expose this entire branch.

Local verification is therefore the real gate. Run the four checks locally instead.

---

## 7. Local development environment (set up 2026-08-19, working)

A portable, no-admin, no-service Postgres was built for local work.

```bash
SCRATCH="C:/Users/k1rby/AppData/Local/Temp/claude/c--Users-k1rby-OneDrive-Desktop-SpacePoker/0af330af-4a2c-4f52-b187-0a7965cb6ae0/scratchpad"
PGBIN="$SCRATCH/pg/pgsql/bin"
PGDATA="$SCRATCH/pg-data"

# start it
nohup "$PGBIN/postgres.exe" -D "$PGDATA" > "$PGDATA/stdout.log" 2>&1 &
```

- **Postgres 17.11**, port **55556**, db `plank`, user `plankapp`, password `local-view-only`
  — deliberately matched to `.env.local` so the app connects with no overrides.
- Encoding **must** be `-E UTF8 --locale=C`. A previous cluster defaulted to WIN1252 and
  died on real Unicode collection names:
  `character with byte sequence 0xe1 0xb4 0xb8 ... has no equivalent in encoding "WIN1252"`.
- All **26 migrations** applied via `npm run db:migrate`.

Scripts don't auto-load `.env.local`, so source it:
```bash
set -a; source <(grep -E "^[A-Z_]+=" .env.local); set +a
```

**Dev server: use port 3800, NOT 3000.** On this machine `wslrelay.exe` owns port 3000 and
forwards it to an unrelated Gitea instance in a different WSL context — so `localhost:3000`
resolves to a *different machine* for the Bash tool vs the browser. This caused hours of
phantom verification failures. `npx next dev -p 3800` binds directly via `node.exe`
(confirmed with `netstat`/`Get-Process`).

**Current local data:** 1,768 collections —
polygon 437 · robinhood 358 · base 272 · arbitrum 167 · bnb 119 · ethereum 88 ·
solana 83 · bitcoin 60 · optimism 33 · **avalanche 0**.

> **Avalanche gap — investigated and CLOSED, not a bug.** Live-verified 2026-08-20: pulled
> raw OpenSea `chain=avalanche` collection-list entries and Alchemy `avax-mainnet`
> `fetchSnapshot` results directly (not through the scanner) for 20 real candidates. Both
> sources independently return `name: null, image_url: null` — OpenSea's own `name` field
> for these entries is literally the lowercase contract address, meaning OpenSea itself has
> never curated them. `isNotRealCollectibleArt` is correctly rejecting genuinely uncurated
> contracts, not misfiring on real art. The `openSeaChain: "avalanche"` slug in
> `foreign-chain-registry.ts` is also confirmed correct (matches the working chains'
> pattern). Conclusion: Avalanche's real gap is thin upstream metadata coverage from both
> OpenSea and Alchemy for that chain, not a filter miscalibration — nothing to fix here
> without a third data source. Per-chain counts have moved since this doc was written:
> re-run `--discover-opensea-bulk` to see current totals (spot-checked 2026-08-20: polygon
> 610, base 381, bnb 270, arb 227, eth 214, robinhood 358, solana 83, bitcoin 60, opt 33,
> **avax still 0**).

### Populating data — use the built orchestrator, don't hand-roll
`scripts/refresh-market-data.ts` already orchestrates ~20 steps. Do **not** write new
discovery scripts before reading it.

```bash
npx tsx scripts/refresh-market-data.ts --discover-opensea-bulk --discover-robinhood-opensea \
  --multichain --own-ranking          # targeted
npx tsx scripts/refresh-market-data.ts --full   # everything
```
Targets: `events sales vault portfolio metadata rarity traits collection opensea pulp
official-assets token-registry owners multichain discover-evm discover-robinhood
discover-robinhood-opensea discover-opensea-bulk own-ranking scaffold-rarity`.

Other real scripts: `scripts/seed-multichain-collections.ts` (hand-verified blue-chips),
`scripts/discover-multichain-collections.ts` (**only 3 chain families** — eth/solana/bitcoin,
by design; it is *not* the full pipeline).

---

## 8. Repository rules (from `CLAUDE.md` / `AGENTS.md` — non-negotiable)

- `master` is the **deploy** branch (push triggers an InMotion build). `dev` is the working branch.
- Resolve vaults **only** via `lib/market/vault-registry.ts` **by address**. Never hardcode.
- **Never render a vault version number in the UI.**
- **Never migrate users into V2** — it has a privately-audited LP-drain flaw. V3
  (`0xacE28f72Fc3e15eA1671e689806694A9b0cE047D`) has been live on mainnet since 2026-08-01.
- Postgres migrations are **append-only**.
- Never commit production secrets. `RELAYER_PRIVATE_KEY` is cron-only.
- Required before shipping: `npm run lint:inmotion`, `npx tsc --noEmit`, `npm test`,
  `npm run build`.

### Verification discipline (learned the hard way this session)
- **Never call a surface "verified" until a real signer drove a real WRITE on-chain.**
  Render + read proves nothing.
- **Verify live, don't assume.** Every genuine bug this session — the dust rejection, both
  UniSat API quirks, the WIN1252 encoding failure — was caught only by a real call, and
  would have passed any unit test.
- Decode actual bytes rather than trusting your own copy-paste. Two wrong-hex mistakes were
  caught this way.

---

## 9. Deployment

- **Primary — InMotion (Passenger/cPanel):** `deploy/inmotion/passenger.cjs`,
  `.env.inmotion.example`, prod env at
  `/home/CPANEL_USER/plank.tanggang.life/shared/.env.production` (mode 600).
  Host `plank.tanggang.life` pending the `plank.love` Cloudflare cutover.
  Runbook: `docs/marketplank/DEPLOY-V3-RUNBOOK.md`.
- **Docker:** `docker-compose.inmotion.yml` — hardened (`cap_drop: ALL`, no-new-privileges,
  internal-only data network). **Always pin the project name with `-p`** — it defaults to
  `plank-love`, which collides with the unrelated plank-love meme-coin repo.
- **Secondary — Cloudflare:** `@opennextjs/cloudflare` (`npm run preview|deploy|upload`).
- `next.config.ts`: `output: "standalone"`, full CSP, per-route cache rules. The multichain
  endpoint is explicitly documented as **cron-precomputed, never live-fetched per request**.

**Market kill-switch:** `MARKET_ENABLED` / `NEXT_PUBLIC_MARKET_ENABLED`. When false,
`ComingSoonGate` is the only thing rendered — no mock data, no live UI.

---

## 10. Design direction (decision pending)

Branch `design/trenches-density-preview`, commit `ead89d6`, **not pushed**.

Research-grounded in what real trader terminals actually do (Axiom's "Trenches", Photon,
Blur, Tensor): every one sets price/volume/percentage data in a **true monospace**, because
`tabular-nums` only aligns digit *widths* in a proportional font — only a real monospace puts
currency symbols, arrows and the decimal point itself on a fixed grid, which is what lets a
scanning eye track a column.

Changes are **purely additive** (72 insertions, 9 deletions — every deletion is a one-line
`className` swap; zero data/logic touched):
- `app/layout.tsx` — JetBrains Mono as a **third** font var `--font-data`, alongside
  `--font-stencil` (Uncial Antiqua, headings) and `--font-body` (Nunito Sans).
- `app/globals.css` — `--font-mono: var(--font-data);` inside `@theme inline` (this is the
  Tailwind v4 pattern that makes `.font-mono` generate), plus a `live-pulse` keyframe that
  respects `prefers-reduced-motion`.
- `components/market/GlobalMarketHub.tsx` — `font-mono` on numeric cells of the Live rankings
  table + a pulsing LIVE badge.

**Explicit verdict already given to the owner:** a literal Commodore 64 aesthetic is *not*
recommended for the trading core — density and legibility win there. Character belongs in
the surrounding chrome, not the price column.

**Status: awaiting the owner's yes/no.** Do not extend this treatment to other surfaces
until they approve.

Also fixed this session: the mobile theme-picker. Root cause was a genuine CSS spec rule —
setting `overflow-y` to anything non-`visible` forces `overflow-x` to compute as `auto` too,
which clipped the absolutely-positioned dropdown inside the mobile menu's scroll container.
Fixed with `position: fixed` + measured coordinates; verified at 375×812 via Playwright.

---

## 11. Where things live

```
lib/market/multichain/
  adapters/          7 adapters: alchemy-nft, defillama-nft, magiceden-solana,
                     magiceden-solana-trade, magiceden-m2-onchain,
                     unisat-collections, unisat-ordinals-trade
  discovery/         evm-log-scan, opensea-bulk-scan, opensea-robinhood-scan,
                     robinhood-chain-scan
  trading/           17 files — foreign-chain-registry, native-bitcoin-listing,
                     native-fulfill, foreign-fulfill, foreign-offer, foreign-orders,
                     solana-*, bitcoin-*, non-evm-*, stablecoins, across/debridge quotes
  store.ts sync.ts seaport-fill-indexer.ts rarity-index-runner.ts ens.ts

app/api/market/multichain/   28 routes
app/api/market/native-*      4 routes (native-order, native-bundle-order,
                             native-swap-order, native-collection)
app/api/market/native-bitcoin-listing/[id]/{fulfill,broadcast}

components/market/           ~60 components
  GlobalMultichainMarketView.tsx   tabs: buy-sell swap offers activity my-nfts positions
  MultichainCollectionView.tsx     same + `sell` (foreign EVM only)
  GlobalMarketHub.tsx              collection browser + live rankings
  NativeBitcoinListingsPanel.tsx   BTC list/buy UI

deploy/inmotion/postgres/migrations/   26 migrations (001–026)
```

**Migrations most relevant to this branch:** `013` multichain collections ·
`014` foreign rarity + discovery cursor · `015` activity stats · `016` trait index ·
`017` creator+stats · `018` creator ENS · `019` `market_orders.chain_slug` ·
`020` bundle listings · `021` wallet theme prefs · `022` swap listings ·
`023`/`024` Seaport fill index + fee shape · `025` admin proof replay guard ·
`026` native Bitcoin listings.

---

## 12. Recommended next steps

1. **Unblock CI** — owner adds a payment method to the GitHub org. Nothing else fixes it,
   and going public is forbidden. Until then, run the four required checks locally and say
   plainly that CI is billing-blocked rather than "failing."
2. **Solana write-path proof** — needs `MAGICEDEN_API_KEY`. Until a real Phantom signature
   settles a real Solana buy on-chain, Solana is *not* proven, regardless of tests.
3. **Design decision** — get a yes/no on `design/trenches-density-preview`; extend or drop.
4. ~~Avalanche discovery gap~~ — **closed 2026-08-20**: confirmed real (both OpenSea and
   Alchemy have zero metadata for Avalanche contracts), not a filter bug. No action
   possible without a third metadata source for that chain.
5. **Mainnet readiness** — decide deliberately whether `NATIVE_BITCOIN_MAINNET_ENABLED`
   flips, and whether the undeployed router/bridge contracts are wanted at all (foreign
   fulfillment already works without them).
6. **Housekeeping** — untracked in the working tree: `START.bat`, `real178.png`, `unrev.png`,
   `scripts/release/`. Decide commit-or-ignore.

---

## 13. Open PRs (11)

`#94` this multichain branch (the big one) · `#93` PlankProgression ·
`#67`/`#66`/`#65` arcade docs · `#63` MoonPay ramp · `#62`/`#61` AXIOM-1 audit ·
`#34`/`#33` Global Index vault · `#25` social wiring.

Parked deliberately: `docs/PARKED-social-and-points-2026-08-19.md` — states the active
priority is **mainnet readiness for the global multichain marketplace**.

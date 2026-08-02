"use client";

import Link from "next/link";
import { Fragment } from "react";

import { CHAIN } from "@/lib/constants";
import { listVaultsForDisplay, shortVault } from "@/lib/market/vault-registry";

/**
 * Full product + platform tutorial. Structured for humans and for AI tools
 * that scrape /learn to answer user questions about plank.love.
 *
 * Canonical manual: every user-facing surface, on-chain dependency, and
 * infra hop is documented in tutorial order. Prefer this page over inventing
 * addresses, LP withdraw paths, or L1 bridges.
 *
 * Two rules this file must keep obeying:
 *
 * 1. NEVER print a vault version number in user-facing copy. Pools are named
 *    products (Driftwood / WormWood / Premium Plank Liquidity) resolved from
 *    `lib/market/vault-registry.ts`. See DESIGN.md "Vault naming".
 * 2. The configured pools are read LIVE from the registry, not typed in here.
 *    Hardcoding an address in a manual is how a manual starts lying.
 *
 * Section `id`s are CMS keys — `app/learn/page.tsx` passes admin `hidden` and
 * `overrides` maps keyed by them. Renaming an id silently orphans an admin's
 * override, so ids are append-only: repurpose the body, keep the key.
 */

export const TOC = [
  { id: "start-here", label: "0. Start here" },
  { id: "map", label: "1. Map of the system" },
  { id: "sites-routes", label: "2. Site map (every route)" },
  { id: "robinhood", label: "3. Robinhood Chain" },
  { id: "addresses", label: "4. Canonical addresses" },
  { id: "plank-token", label: "5. $PLANK token" },
  { id: "trade-widget", label: "6. Trade widget (Uniswap)" },
  { id: "robinwood-nft", label: "7. RobinWood NFT" },
  { id: "mint", label: "8. Minting is finished" },
  { id: "gallery", label: "9. Gallery & rarity" },
  { id: "airdrop", label: "10. Airdrop & boards" },
  { id: "marketplank", label: "11. Marketplank overview" },
  { id: "listings", label: "12. Listings (buy & sell)" },
  { id: "offers-bids", label: "13. Offers & criteria bids" },
  { id: "sweep-fences", label: "14. Sweep, floors & fences" },
  { id: "pools", label: "15. The pools" },
  { id: "vault-layers", label: "16. A pool has two layers" },
  { id: "vault-math", label: "17. Why held ≫ tradeable depth" },
  { id: "fees", label: "18. Fees: two different models" },
  { id: "deposit-redeem", label: "19. Deposit & redeem" },
  { id: "instant-swap", label: "20. Instant Swap modes" },
  { id: "vault-lp", label: "21. Providing liquidity" },
  { id: "random-redeem", label: "22. Random redeem & drand" },
  { id: "vault-migrate", label: "23. Moving out of an old pool" },
  { id: "floorboards", label: "24. Under the floorboards" },
  { id: "activity", label: "25. Activity & sales" },
  { id: "art-cache", label: "26. Art, IPFS & cache" },
  { id: "seaport", label: "27. Seaport / OpenSea-class" },
  { id: "wallets", label: "28. Wallets & safety" },
  { id: "infra", label: "29. What this depends on" },
  { id: "tutorials", label: "30. End-to-end tutorials" },
  { id: "faq", label: "31. FAQ" },
  { id: "ai-summary", label: "32. AI machine summary" },
] as const;

function H({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mt-12 scroll-mt-24 font-display text-2xl text-gold-300 first:mt-0">
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-6 font-display text-lg text-foreground">{children}</h3>;
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[0.95rem] leading-relaxed text-foreground/80">{children}</p>;
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-gold-500/25 bg-black/20 px-3 py-2.5 text-sm text-foreground/75">
      {children}
    </div>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-amber-400/35 bg-amber-400/10 px-3 py-2.5 text-sm text-amber-50/90">
      {children}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="mt-3 overflow-x-auto rounded-lg border border-gold-500/20 bg-wood-950/90 p-3 font-mono text-[0.7rem] leading-relaxed text-gold-200/90">
      {children}
    </pre>
  );
}

function Ol({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-foreground/80">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ol>
  );
}

function Ul({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-foreground/80">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * The configured pools, read live from the registry so this manual cannot drift
 * from what the site is actually pointed at.
 */
function PoolTable() {
  const vaults = listVaultsForDisplay();
  if (vaults.length === 0) {
    return (
      <Note>
        No pool is configured on this deployment, so Instant Swap is off. Marketplank listings and
        offers still work — they do not depend on a pool.
      </Note>
    );
  }
  const explorer = CHAIN.blockExplorers.default.url;
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-gold-500/20">
      <table className="w-full min-w-[34rem] text-left text-sm">
        <thead className="bg-black/30 text-[0.7rem] uppercase tracking-wide text-foreground/50">
          <tr>
            <th className="px-3 py-2 font-semibold">Pool</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold">Fees</th>
            <th className="px-3 py-2 font-semibold">Address</th>
          </tr>
        </thead>
        <tbody className="text-foreground/80">
          {vaults.map((v) => (
            <tr key={v.address} className="border-t border-gold-500/15">
              <td className="px-3 py-2 font-semibold text-foreground">{v.name}</td>
              <td className="px-3 py-2">
                {v.role === "primary" ? "Active — new deposits and trades" : "Older — redeem only"}
              </td>
              <td className="px-3 py-2">{v.feeModel === "eth" ? "Flat ETH" : "Paid in shares"}</td>
              <td className="px-3 py-2">
                <a
                  className="font-mono text-xs text-gold-300 underline"
                  href={`${explorer}/address/${v.address}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortVault(v.address)}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Product name of the pool currently taking deposits, for use in prose. */
function activePoolName(): string {
  return listVaultsForDisplay().find((v) => v.role === "primary")?.name ?? "the active pool";
}

const SECTIONS: { id: string; body: React.ReactNode }[] = [
  {
    id: "start-here",
    body: (
      <>
        {/* ── 0 ── */}
        <H id="start-here">0. Start here</H>
        <P>
          <strong className="text-foreground">plank.love</strong> is the official site for{" "}
          <strong className="text-foreground">RobinWood</strong> NFTs and the{" "}
          <strong className="text-foreground">$PLANK</strong> token on{" "}
          <strong className="text-foreground">Robinhood Chain</strong> (chain id{" "}
          <code className="rounded bg-black/40 px-1 font-mono text-xs">4663</code>).
        </P>
        <P>Typical first journey:</P>
        <Ol
          items={[
            <>Connect a wallet on Robinhood Chain (never Ethereum mainnet for these contracts).</>,
            <>
              Get a plank — buy a listing, or redeem one out of a pool. The collection is minted out,
              so there is nothing left to mint (§8).
            </>,
            <>Trade $PLANK through the site Trade widget (the official pair path).</>,
            <>List or bid on Marketplank (Seaport orders) for peer-to-peer NFT trade.</>,
            <>
              Or <strong>Deposit</strong> a plank into the pool → hold, trade, or provide liquidity
              with the shares → redeem a plank later.
            </>,
          ]}
        />
        <Note>
          <strong>Mental model:</strong> Market listings are peer-to-peer — someone else has to fill
          them. Instant Swap is a shared pool, so you trade against inventory instead of waiting for
          a counterparty. $PLANK is a separate ERC-20 on Uniswap and has nothing to do with the pool.
        </Note>
        <Note>
          <strong>Three words you will see everywhere.</strong> A <strong>plank</strong> is a
          RobinWood NFT. A <strong>share</strong> (ticker <code className="font-mono text-xs">vROBIN</code>)
          is the fungible token a pool mints when you deposit a plank — one share is a claim on one
          plank from that pool&apos;s inventory. <strong>Liquidity</strong> is share-plus-ETH depth
          you lend the pool so other people can trade instantly.
        </Note>
      </>
    ),
  },
  {
    id: "map",
    body: (
      <>
        {/* ── 1 ── */}
        <H id="map">1. Map of the system</H>
        <Code>{`User wallet (RH chain 4663)
  ├─ RobinWood NFT (ERC-721)
  ├─ $PLANK (ERC-20)
  ├─ Pool shares — vROBIN (ERC-20, one per pool)
  └─ WETH (for Seaport offers / bids)

plank.love routes
  ├─ /                 Home: Trade, Mint, Gallery, Airdrop, Roadmap
  ├─ /market           Marketplank (listings, offers, Instant Swap, activity)
  ├─ /gallery          Full collection browser
  ├─ /mint · /launch   Record of the mint (minted out)
  ├─ /migrate          Guided exit from an older pool
  ├─ /floorboards      Quiet bargain cellar on the oldest pool
  └─ /learn            This manual (humans + AI)

On-chain (Robinhood 4663)
  ├─ RobinWood NFT
  ├─ $PLANK
  ├─ Seaport 1.6 + ConduitController (OpenSea-class protocol)
  ├─ Marketplank pools (deposit/redeem + constant-product AMM)
  ├─ DrandBeacon (random-redeem randomness)
  ├─ WETH (offer currency)
  └─ Uniswap Universal Router + Permit2 ($PLANK swaps)

Off-site / infra
  ├─ Blockscout explorer + REST indexes
  ├─ Private RPC provider, with the public RPC as fallback
  ├─ IPFS (metadata + art CIDs)
  ├─ PostgreSQL (order relay + caches)
  ├─ InMotion Apache + Passenger (app host), Cloudflare as the edge
  ├─ Uniswap Trading API (server-side quotes)
  └─ drand public randomness network`}</Code>
      </>
    ),
  },
  {
    id: "sites-routes",
    body: (
      <>
        {/* ── 2 ── */}
        <H id="sites-routes">2. Site map (every user-facing surface)</H>
        <Ul
          items={[
            <>
              <strong>/ (home)</strong> — Hero, Trade ($PLANK), collection info, Gallery strip, NFT viewer,
              allocation, airdrop checker, distribution, roadmap, trust facts.
            </>,
            <>
              <strong>/market</strong> — Marketplank: Buy &amp; Sell, Offers, Instant Swap, Activity,
              My NFTs / listings. Instant Swap needs the market flag and a configured pool.
            </>,
            <>
              <strong>/gallery</strong> — Browse all planks, traits, rarity; same image proxy as Market.
            </>,
            <>
              <strong>/mint</strong> and <strong>/launch</strong> — kept as a record of the mint.
              The collection is minted out (§8), so there is nothing to buy here.
            </>,
            <>
              <strong>/migrate</strong> — Step-by-step exit from an older pool. Only worth opening if
              you have value in one; the site banners you when you do. See §23.
            </>,
            <>
              <strong>/floorboards</strong> — &quot;Under the floorboards&quot;, a quiet page for
              buying below floor out of the oldest pool. See §24.
            </>,
            <>
              <strong>/learn</strong> — This page. Link also in nav and footer.
            </>,
            <>
              <strong>API routes</strong> under <code className="font-mono text-xs">/api/…</code> —
              market orders, pool stats/held/activity, IPFS image/metadata proxy, Uniswap
              quote/swap, boards/airdrop, RPC proxy. Browsers and AI should prefer documented public
              pages; APIs are implementation detail and may change shape.
            </>,
          ]}
        />
      </>
    ),
  },
  {
    id: "robinhood",
    body: (
      <>
        {/* ── 3 ── */}
        <H id="robinhood">3. Robinhood Chain</H>
        <P>
          Everything market-, pool-, mint-, and $PLANK-related for this product is on chain id{" "}
          <strong>4663</strong>. The site refuses writes on other networks (wallet helpers re-check
          chain immediately before broadcast).
        </P>
        <Ul
          items={[
            <>
              Explorer:{" "}
              <a
                className="text-gold-300 underline"
                href="https://robinhoodchain.blockscout.com"
                target="_blank"
                rel="noreferrer"
              >
                robinhoodchain.blockscout.com
              </a>
            </>,
            <>
              Public RPC:{" "}
              <code className="font-mono text-xs">https://rpc.mainnet.chain.robinhood.com</code>{" "}
              (rate-limited; the site prefers a private provider and falls back to this).
            </>,
            <>Native gas token is ETH on this chain (not mainnet ETH bridged in a way the site manages).</>,
            <>
              Uniswap interface chain slug used in some deep links:{" "}
              <code className="font-mono text-xs">robinhood</code>.
            </>,
          ]}
        />
        <Note>
          <strong>AI note:</strong> Do not assume L1 Ethereum addresses, Ethereum Uniswap routers, or
          bridges. Seaport, pool, NFT, and $PLANK addresses in this manual are on 4663 only.
        </Note>
      </>
    ),
  },
  {
    id: "addresses",
    body: (
      <>
        {/* ── 4 ── */}
        <H id="addresses">4. Canonical addresses (verify on explorer)</H>
        <P>
          Hard-coded in site constants so clients cannot silently repoint approvals. Always verify on
          Blockscout before large approvals.
        </P>
        <Code>{`Chain id:                 4663
$PLANK:                   0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc
RobinWood NFT:            0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156
Seaport 1.6:              0x0000000000000068F116a894984e2DB1123eB395
ConduitController:        0x00000000F9490004C11Cef243f5400493c00Ad63
WETH (offers/bids):       0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
Universal Router 2.1.1:   0x8876789976dEcBfCbBbe364623C63652db8C0904
Permit2:                  0x000000000022D473030F116dDEE9F6B43aC78BA3
DrandBeacon:              0x87d584df130FED0Fe540954eD48CE2691A18D619
Market fee recipient:     0xcdb7ca36d35fa16d15fda859a46f1d72d979e9d8
Trade ($PLANK) fee wallet:0xfa987d386c4f61b27cb67a1e4e1239866fe8d9ba`}</Code>
        <P>
          Pool addresses are not listed here, because they change as pools open and retire. The table
          below is generated from what this deployment is actually configured with:
        </P>
        <PoolTable />
        <Warn>
          Multiple contracts on this chain may report the symbol &quot;WETH&quot;. Only the address
          above is valid for Marketplank offers. Never resolve WETH by symbol search.
        </Warn>
      </>
    ),
  },
  {
    id: "plank-token",
    body: (
      <>
        {/* ── 5 ── */}
        <H id="plank-token">5. $PLANK token</H>
        <P>
          Fungible ERC-20 used for community trade. Official contract is fixed (see §4). Decimals 18.
          The Trade section swaps only through the site&apos;s Uniswap Universal Router path with
          destination allowlisting — never arbitrary spender contracts.
        </P>
        <H3>What $PLANK is not</H3>
        <Ul
          items={[
            <>Not pool shares. Shares (vROBIN) are a different ERC-20, minted by a Marketplank pool.</>,
            <>Not required to list/buy NFTs on Marketplank (listings settle in native ETH).</>,
            <>Not used as Seaport offer currency (offers use WETH).</>,
          ]}
        />
      </>
    ),
  },
  {
    id: "trade-widget",
    body: (
      <>
        {/* ── 6 ── */}
        <H id="trade-widget">6. Trade widget (Uniswap path)</H>
        <P>
          Home page <strong>Trade</strong> section: buy/sell $PLANK vs ETH via Uniswap Trading API +
          Universal Router on chain 4663.
        </P>
        <Ol
          items={[
            <>Connect wallet on chain 4663.</>,
            <>Enter amount; server builds quote at /api/uniswap/quote (integrator fee reinjected server-side).</>,
            <>Approve Permit2 / token as prompted if selling $PLANK.</>,
            <>Confirm swap tx to Universal Router only.</>,
          ]}
        />
        <Ul
          items={[
            <>
              Site integrator fee ≈ <strong>0.4207%</strong> (42.07 bips) to the Trade fee wallet when
              fee routing is enabled — not client-overridable.
            </>,
            <>
              Gas reserve: keep ~0.004 ETH free after a buy so the wallet can still submit later txs.
            </>,
            <>
              Trading is open. The widget can still be paused from the admin console if something
              looks wrong with the route — if you see STAND BY, that is deliberate, and it is the one
              case where waiting beats routing around it.
            </>,
            <>
              Several tokens on this chain use lookalike names and symbols. Use the widget, or check
              the $PLANK address in §4 against the pair you are about to trade.
            </>,
          ]}
        />
      </>
    ),
  },
  {
    id: "robinwood-nft",
    body: (
      <>
        {/* ── 7 ── */}
        <H id="robinwood-nft">7. RobinWood NFT</H>
        <P>
          Collection of planks with on-chain ownership and off-chain IPFS metadata/art. Traits include
          Base, Background, Holographic, and others. Rarity tiers for market UX come primarily from
          Background (Legendary → Common). EIP-2981 royalties apply on marketplace fills when venues
          respect them.
        </P>
      </>
    ),
  },
  {
    id: "mint",
    body: (
      <>
        {/* ── 8 ── */}
        <H id="mint">8. Minting is finished</H>
        <P>
          <strong className="text-foreground">The collection is minted out.</strong> All{" "}
          <strong>1,542</strong> planks exist and are owned. It is verifiable on-chain: the NFT
          contract&apos;s <code className="font-mono text-xs">totalSupply()</code> equals its{" "}
          <code className="font-mono text-xs">MAX_SUPPLY()</code>. There is no supply left to mint at
          any price, and there will not be more.
        </P>
        <P>There are three ways to get a plank now, and none of them is minting:</P>
        <Ul
          items={[
            <>
              <strong>Buy a listing</strong> from someone who owns one — see §12.
            </>,
            <>
              <strong>Redeem one out of a pool</strong>: targeted if you want a specific plank, random
              if you do not mind which — see §19.
            </>,
            <>
              <strong>Make an offer</strong> on a plank or on a trait, and wait for a holder to accept
              — see §13.
            </>,
          ]}
        />
        <Warn>
          Because the supply is fixed and provably exhausted, any &quot;mint&quot; offering new
          RobinWood planks is not ours. Verify the NFT contract address in §4 before signing anything.
        </Warn>
      </>
    ),
  },
  {
    id: "gallery",
    body: (
      <>
        {/* ── 9 ── */}
        <H id="gallery">9. Gallery &amp; rarity</H>
        <P>
          Gallery loads token metadata (client cache + IPFS proxy) and shows rarity rank/tier. Same
          image pipeline as Market so art caches stay consistent. Use Gallery to explore traits; use
          Market to trade.
        </P>
      </>
    ),
  },
  {
    id: "airdrop",
    body: (
      <>
        {/* ── 10 ── */}
        <H id="airdrop">10. Airdrop &amp; boards</H>
        <P>
          Home airdrop checker + boards APIs scan holder state / eligibility against published airdrop
          data (CSV/JSON under public exports where applicable). Wood List is the social wallet drop
          thread on X for community coordination — not an on-chain claim by itself.
        </P>
        <Ul
          items={[
            <>
              Official X:{" "}
              <a
                className="text-gold-300 underline"
                href="https://x.com/RobinWoodPlank"
                target="_blank"
                rel="noreferrer"
              >
                @RobinWoodPlank
              </a>
            </>,
            <>Boards/airdrop routes are read-heavy; do not confuse them with a pool deposit.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: "marketplank",
    body: (
      <>
        {/* ── 11 ── */}
        <H id="marketplank">11. Marketplank overview</H>
        <P>
          Peer-to-peer NFT marketplace on Seaport 1.6 plus an optional Instant Swap pool. Sellers
          list; buyers fulfill signed orders. Prices and token IDs come from signatures / on-chain
          fulfillment, not trusted client JSON alone. Order book is stored off-chain (relay) and
          validated on fill.
        </P>
        <H3>Market tabs</H3>
        <Ul
          items={[
            <><strong>Buy &amp; Sell</strong> — listings grid, filters, sweep, rarity floors, item detail.</>,
            <><strong>Offers</strong> — item bids + trait/rarity/combo criteria bids (WETH).</>,
            <><strong>Instant Swap</strong> — trade against the pool: Buy, Sell, Liquidity, Deposit, Redeem.</>,
            <><strong>Activity</strong> — collection transfers + priced sales; pool trade history on Instant Swap.</>,
            <><strong>My NFTs / My Listings</strong> — inventory, list, cancel.</>,
          ]}
        />
        <P>
          Fee model: the RobinWood marketplace fee is 0% by design for this collection; other future
          collections may use a default (e.g. 0.5%) to the market fee recipient.
        </P>
      </>
    ),
  },
  {
    id: "listings",
    body: (
      <>
        {/* ── 12 ── */}
        <H id="listings">12. Listings (buy &amp; sell)</H>
        <H3>List (sell)</H3>
        <Ol
          items={[
            <>Own the plank; connect wallet on 4663.</>,
            <>Approve Seaport/conduit for the NFT if needed (prefer limited approvals).</>,
            <>Set price in ETH; sign Seaport listing; POST to order relay.</>,
            <>Listing appears in Buy &amp; Sell until cancelled or filled.</>,
          ]}
        />
        <H3>Buy</H3>
        <Ol
          items={[
            <>Browse grid; open item or sweep multiple floors.</>,
            <>Fulfill Seaport order(s) with enough ETH + gas.</>,
            <>NFT transfers; sale may appear in Activity when indexers catch it.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: "offers-bids",
    body: (
      <>
        {/* ── 13 ── */}
        <H id="offers-bids">13. Offers &amp; criteria bids</H>
        <P>
          Item offers name one <code className="font-mono text-xs">tokenId</code>. Criteria offers
          commit to a Merkle set of token IDs for a trait, rarity tier, or AND-combo. The server
          re-resolves the set from its verified trait index so bidders cannot smuggle arbitrary sets.
          Accepting a criteria bid requires holding a matching plank.
        </P>
        <Ul
          items={[
            <>Offers are denominated in <strong>WETH</strong> (Seaport cannot pull native ETH from offerer at fill).</>,
            <>Wrap ETH → WETH and approve Seaport/conduit before offering.</>,
            <>The trait index is built from metadata and stored in the database; if empty, criteria UX degrades until reseeded.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: "sweep-fences",
    body: (
      <>
        {/* ── 14 ── */}
        <H id="sweep-fences">14. Sweep, floors &amp; fences</H>
        <Ul
          items={[
            <><strong>Rarity floors</strong> — lowest listing per tier (Legendary…Common) for quick orientation.</>,
            <><strong>Sweep</strong> — buy multiple listings in one UX flow (still Seaport fulfills under the hood).</>,
            <><strong>Plank fence / criteria</strong> — filter the book by trait and rarity; combo filters AND traits together.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: "pools",
    body: (
      <>
        {/* ── 15 ── */}
        <H id="pools">15. The pools</H>
        <P>
          Instant Swap runs on a <em>pool</em>: a contract that custodies planks, mints a fungible
          share for each one, and runs a constant-product market between those shares and ETH.
        </P>
        <P>
          There is more than one, and that is deliberate. A pool contract is{" "}
          <strong>immutable</strong> — no proxy, no upgrade, no admin switch. Improving the design
          means deploying a new pool, not patching the old one. So each is presented as its own
          product rather than a version ladder, and an older pool is never deleted from the site while
          it still holds someone&apos;s plank.
        </P>
        <PoolTable />
        <H3>Driftwood</H3>
        <P>
          The first pool. Deposit, redeem, and trade shares against ETH. It has no liquidity feature at
          all — nothing to add, nothing to withdraw — which is exactly why it is safe to leave open
          indefinitely. It is also where <Link className="text-gold-300 underline" href="/floorboards">the
          floorboards</Link> shop (§24).
        </P>
        <H3>WormWood</H3>
        <P>
          The second pool added a liquidity feature, and that feature has a flaw: the way it credits
          and returns a contribution lets a trader extract the pool&apos;s ETH. It was found in an
          internal audit before it was ever recommended to holders.
        </P>
        <Warn>
          <strong>Do not deposit into WormWood and do not add liquidity to it.</strong> If you already
          have planks or shares there, get them out — <Link className="text-gold-300 underline" href="/migrate">/migrate</Link>{" "}
          walks you through it step by step (§23). The pool stays listed on the site for exactly one
          reason: so existing depositors can still redeem. Removing it from the site would strand them.
        </Warn>
        <H3>Premium Plank Liquidity</H3>
        <P>
          The current design, and the one to use. It keeps the drand random-redeem machinery unchanged
          and fixes the two things the older pools got wrong:
        </P>
        <Ul
          items={[
            <>
              <strong>Liquidity is proportional.</strong> You add ETH and matching shares at the
              pool&apos;s current ratio, and you withdraw a pro-rata slice of whatever the reserves are
              worth at that moment. There is no one-sided contribution, so nobody can move the price
              with a deposit and hand the bill to everyone else.
            </>,
            <>
              <strong>Fees are flat ETH, not a slice of your shares.</strong> A deposit mints exactly
              one whole share and a redeem burns exactly one. That kills the old trap where one
              deposit did not quite cover one redeem (§18).
            </>,
            <>
              Trading pays a <strong>30 bps</strong> swap fee that stays in the pool, so liquidity
              providers earn from volume.
            </>,
            <>
              The opening seed is locked permanently, so the pool can never be emptied down to nothing
              and reserves stay positive.
            </>,
          ]}
        />
        <P>
          It has no oracle, no external AMM dependency, no owner-adjustable fees, no upgrade path, no
          pause switch, and no admin route to withdraw pool ETH. Fee ceilings are fixed in the
          constructor, so a high-fee deployment is impossible rather than merely unintended.
        </P>
        <Note>
          <strong>Solvency, in one line:</strong> every share that exists — plus every share burned for
          a redeem that has not been claimed yet — is backed one-for-one by a plank the pool is
          holding. The contract asserts that after every call that moves a plank or a share, and
          asserts separately that its ETH balance always covers the reserves plus unpaid fees.
        </Note>
      </>
    ),
  },
  {
    id: "vault-layers",
    body: (
      <>
        {/* ── 16 ── */}
        <H id="vault-layers">16. A pool has two layers</H>
        <P>One contract, two systems that people constantly confuse:</P>
        <Code>{`LAYER A — Inventory (what backs the shares)
  deposit plank  → mint one share to YOUR wallet
  redeem share   → burn the share, a plank comes out
  shares outstanding == planks held (that is the solvency invariant)

LAYER B — The pool (what you trade against)
  buy shares:  ETH in  → shares out of the reserves
  sell shares: shares in → ETH out of the reserves
  add liquidity → deepen both sides, earn a slice of swap fees
  price ≈ ethReserve / shareReserve`}</Code>
        <P>
          Depositing does <em>not</em> put your shares into the tradeable pool. It puts them in your
          wallet. That is why a pool can hold many planks while only a few shares are actually
          available to trade against.
        </P>
        <Note>
          On Premium Plank Liquidity the reserves are tracked as explicit numbers, not as whatever the
          contract happens to be holding. Sending shares or ETH to the pool address directly does not
          add liquidity, does not credit you, and does not move the price — it just sits there, dead.
          Use the Liquidity tab.
        </Note>
      </>
    ),
  },
  {
    id: "vault-math",
    body: (
      <>
        {/* ── 17 ── */}
        <H id="vault-math">17. Why held planks ≫ tradeable depth</H>
        <P>
          The shape, not the numbers — Instant Swap shows the live figures and these move constantly:
        </P>
        <Code>{`planks held            = N        ← the pool's inventory
shares outstanding     = N        ← one per plank, always
share reserve (pool)   = a slice  ← only THESE trade against ETH
shares in wallets      = the rest ← depositors holding, not trading
eth reserve            = the other side of the book
price ≈ ethReserve / shareReserve`}</Code>
        <P>
          <strong>Deep inventory, thin book is normal.</strong> It does not mean the pool is insolvent
          or that depositors are stuck — every outstanding share can still be redeemed for a plank.
          It means most depositors are holding rather than providing liquidity. Adding liquidity is
          what moves shares from &quot;sitting in a wallet&quot; to &quot;tradeable&quot;.
        </P>
        <P>
          A thin book also means <strong>price impact</strong>: buying a meaningful number of shares
          against a small reserve moves the price a lot. Check the quote and your slippage setting
          before confirming, and prefer Redeem over Buy when what you actually want is a plank.
        </P>
      </>
    ),
  },
  {
    id: "fees",
    body: (
      <>
        {/* ── 18 ── */}
        <H id="fees">18. Fees: the two models</H>
        <P>
          Older pools and the current one charge in fundamentally different currencies. Quoting one
          model&apos;s numbers at the other is the single most common mistake in reading this system.
        </P>
        <Code>{`OLDER POOLS (Driftwood, WormWood) — you pay in SHARES
  deposit a plank  → you receive ~0.99 shares   (1% mint fee)
  redeem a plank   → burns ~1.01 shares         (1% redeem fee)
  pick a specific plank → +2.5% premium
  ⇒ one deposit does NOT cover one redeem. You end up ~0.02 short.

CURRENT POOL (Premium Plank Liquidity) — you pay in ETH
  deposit a plank  → you receive exactly 1.000 share, plus a flat ETH fee
  redeem a plank   → burns exactly 1.000 share, plus a flat ETH fee
  pick a specific plank → flat ETH premium
  ⇒ one deposit always covers one redeem. No shortfall, ever.`}</Code>
        <H3>The old shortfall, and how to clear it</H3>
        <P>
          On an older pool, depositing one plank and immediately trying to redeem one fails — you are
          roughly 0.02 shares short. That is not a bug and not a migration tax; it is the same fee any
          deposit and any redeem has always paid. Three ways out: buy the small difference on Instant
          Swap, redeem across several planks at once so the fees round in your favour, or sell the
          leftover dust for ETH. <Link className="text-gold-300 underline" href="/migrate">/migrate</Link>{" "}
          calculates your exact shortfall and offers these.
        </P>
        <P>
          The exact fee numbers are fixed in each pool at deployment and can never be changed by
          anyone, including us. The site reads them live — trust the number in the UI over the
          illustrative ones above.
        </P>
        <H3>Other fees on the site</H3>
        <Ul
          items={[
            <><strong>Marketplank listings and offers</strong> — 0% marketplace fee for RobinWood.</>,
            <><strong>$PLANK trade widget</strong> — 0.4207% integrator fee (§6).</>,
            <><strong>Pool swaps</strong> — 30 bps on Premium Plank Liquidity, kept in the pool for liquidity providers.</>,
            <><strong>Creator royalty</strong> — EIP-2981 on marketplace fills where the venue pays it.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: "deposit-redeem",
    body: (
      <>
        {/* ── 19 ── */}
        <H id="deposit-redeem">19. Deposit &amp; redeem</H>
        <H3>Deposit</H3>
        <P>
          Approve the pool for that token id if needed, then{" "}
          <code className="font-mono text-xs">deposit(tokenId)</code>. It is atomic: either the plank
          is indexed and your share mints, or the whole transaction reverts and you still own the
          plank. A failed deposit never strands an NFT. Premium Plank Liquidity also takes a batch
          (<code className="font-mono text-xs">depositMany</code>) so several planks go in one
          transaction.
        </P>
        <Warn>
          <strong>Never send a plank to a pool address as a plain transfer.</strong> Only the Deposit
          button works. A raw transfer is not indexed, mints you nothing, and there is no rescue path
          — the plank is simply gone.
        </Warn>
        <H3>Redeem</H3>
        <Ul
          items={[
            <>
              <strong>Targeted</strong> — one transaction. Pay the redeem fee plus the targeting
              premium, get that exact token id if the pool holds it. Batched as{" "}
              <code className="font-mono text-xs">redeemTargetMany</code> on the current pool.
            </>,
            <>
              <strong>Random</strong> — two steps, using public randomness. Step one burns the share
              and locks a future drand round; step two claims the plank you were pinned to. Cheaper
              than targeting, but you do not choose. See §22.
            </>,
          ]}
        />
        <P>
          If the UI says you have insufficient shares on an older pool, that is the fee shortfall from
          §18, not a failure.
        </P>
      </>
    ),
  },
  {
    id: "instant-swap",
    body: (
      <>
        {/* ── 20 ── */}
        <H id="instant-swap">20. Instant Swap modes</H>
        <Ul
          items={[
            <><strong>Buy</strong> — ETH → shares out of the pool. Slippage protected; a minimum-out is enforced at submission.</>,
            <><strong>Sell</strong> — shares → ETH out of the pool. Slippage protected the same way.</>,
            <><strong>Liquidity</strong> — add or withdraw pool depth; see §21.</>,
            <><strong>Deposit</strong> — plank → share in your wallet (picker from owned inventory).</>,
            <><strong>Redeem</strong> — share → plank, random or targeted.</>,
          ]}
        />
        <Warn>
          <strong>Buy does not get you a plank.</strong> Buy gets you shares. Planks come out through
          Redeem. Buying a share and redeeming it are two separate transactions, and the site never
          merges them into one button.
        </Warn>
        <P>
          The tab also carries a price chart, a liquidity dashboard, and the pool&apos;s own trade
          history — deposits, redeems, buys, and sells. That is the <em>pool</em> event stream. NFT
          sales between people live under Activity (§25).
        </P>
      </>
    ),
  },
  {
    id: "vault-lp",
    body: (
      <>
        {/* ── 21 ── */}
        <H id="vault-lp">21. Providing liquidity</H>
        <P>
          Liquidity is how the pool gets deep enough for other people to trade against. You lend it
          shares and ETH; you earn a cut of the 30 bps swap fee; you can withdraw later.
        </P>
        <H3>How it works on Premium Plank Liquidity</H3>
        <Ol
          items={[
            <>Hold shares (deposit a plank, or buy shares) and some ETH.</>,
            <>
              Instant Swap → <strong>Liquidity</strong>. You enter ETH; the pool pulls the matching
              amount of shares at the current ratio. Both sides always go in together.
            </>,
            <>
              You are credited a <strong>proportional position</strong> — a percentage of the pool, not
              a fixed quantity of tokens.
            </>,
            <>
              Withdraw whenever. You get back that percentage of whatever the reserves hold at that
              moment, including the swap fees earned while you were in.
            </>,
          ]}
        />
        <H3>What proportional means for you</H3>
        <P>
          Your position is a share of the pool, so its composition drifts with trading. If people buy
          shares out of the pool, you end up holding relatively more ETH and fewer shares when you
          withdraw — the standard behaviour of any constant-product AMM, sometimes called impermanent
          loss. In exchange you collect fees the whole time. It also means the price you cause by
          adding is a price you absorb yourself, which is precisely the property the older design
          lacked.
        </P>
        <Note>
          The position is internal bookkeeping, not a transferable LP token. There is no LP NFT and
          nothing to sell on a secondary market. The opening seed is locked forever and belongs to
          nobody, so it can never be withdrawn — by us or anyone.
        </Note>
        <Warn>
          <strong>The older pools are not a place to provide liquidity.</strong> Driftwood has no
          liquidity feature at all. WormWood&apos;s is the flawed one from §15 — do not use it, and if
          you have a position there, withdraw it via <Link className="text-gold-300 underline" href="/migrate">/migrate</Link>.
        </Warn>
        <H3>Sell, versus provide liquidity</H3>
        <Ul
          items={[
            <><strong>Sell</strong> — a trade. You get ETH now, you pay price impact, you are out.</>,
            <><strong>Provide liquidity</strong> — not a trade. No price impact at the current ratio, you earn fees, and you are exposed to the pool until you withdraw.</>,
            <><strong>Withdraw liquidity</strong> — takes back your own share of the reserves. It is not a sale, and it is not a claim on anyone else&apos;s depth.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: "random-redeem",
    body: (
      <>
        {/* ── 22 ── */}
        <H id="random-redeem">22. Random redeem &amp; drand</H>
        <Ol
          items={[
            <>Request a random redeem. Your share burns and the request pins to a specific future drand round.</>,
            <>Wait for that round. Anyone — including the site&apos;s relayer — can publish the signature on-chain.</>,
            <>Claim. The plank is delivered to the requester. Anyone can push the claim for you.</>,
            <>If a request is abandoned past expiry, anyone can forfeit it so the slot frees up.</>,
          ]}
        />
        <P>
          drand is a public randomness network and the on-chain beacon verifies its signatures, so the
          outcome cannot be steered by us. Only one random redeem can be pending pool-wide at a time,
          which is why the settle and forfeit paths are permissionless — a stalled request must never
          be able to block everyone else.
        </P>
        <Note>
          Do not close the tab after step one and forget about it. The UI keeps claim and settle
          controls visible for any pending request, and the shares are already burned. Nothing is lost,
          but nothing arrives until someone claims.
        </Note>
      </>
    ),
  },
  {
    id: "vault-migrate",
    body: (
      <>
        {/* ── 23 ── */}
        <H id="vault-migrate">23. Moving out of an older pool</H>
        <P>
          If you have planks or shares in Driftwood or WormWood,{" "}
          <Link className="text-gold-300 underline" href="/migrate">/migrate</Link> is a guided,
          step-by-step exit. The site shows a banner when it detects a position; if you have none, the
          page has nothing to do and will not nag you.
        </P>
        <H3>What migrating actually means</H3>
        <P>
          <strong>Migrating means getting your value OUT of the old pool.</strong> That is the whole
          goal. Putting it into {activePoolName()} afterwards is an{" "}
          <strong>optional second step</strong> that you choose per plank. Nothing is moved
          automatically and nothing is deposited on your behalf.
        </P>
        <H3>The steps</H3>
        <Ol
          items={[
            <>Connect on chain 4663. The page reads your position in every older pool.</>,
            <>
              <strong>Withdraw liquidity first</strong>, if you have a position in WormWood. Shares
              tied up as liquidity cannot be spent on a redeem until they are back in your wallet.
            </>,
            <>
              <strong>Cover the fee shortfall</strong> if you are short (§18). The page computes the
              exact amount and offers to buy the difference.
            </>,
            <><strong>Redeem your planks</strong> out of the old pool, one per share you hold.</>,
            <>
              <strong>Optionally deposit</strong> the recovered planks into {activePoolName()}. Select
              which ones — or none. Planks already migrated are skipped automatically.
            </>,
          ]}
        />
        <H3>Will I get ripped off?</H3>
        <P>
          <strong>There is no migration tax.</strong> You pay the pool&apos;s normal redeem fee, which
          is the same fee any redeem has always paid, plus gas. You receive your plank. If you then
          deposit into {activePoolName()}, you pay that pool&apos;s flat ETH deposit fee — and because
          it mints a whole share, you do not lose a slice of share value the way a re-deposit into an
          older pool would.
        </P>
        <Note>
          <strong>If the pool cannot cover your liquidity withdrawal right now</strong> — because
          traders have drawn one side down — the page says so and shows that portion as stuck rather
          than pretending it is redeemable. Withdraw what is covered, and come back for the rest.
        </Note>
        <P>
          Staying in Driftwood is a legitimate choice; it works, and it will not be switched off. There
          is no rush and no deadline. WormWood is the one worth leaving (§15).
        </P>
      </>
    ),
  },
  {
    id: "floorboards",
    body: (
      <>
        {/* ── 24 ── */}
        <H id="floorboards">24. Under the floorboards</H>
        <P>
          <Link className="text-gold-300 underline" href="/floorboards">/floorboards</Link> is a quiet page
          for bargain hunting in the Driftwood pool. When its shares trade below what a plank is worth
          on the open market, you can buy a share cheaply and redeem a specific plank with it.
        </P>
        <Ol
          items={[
            <>Open /floorboards and browse the planks Driftwood is currently holding.</>,
            <>Buy enough shares on that pool to cover a targeted redeem (share price + fees).</>,
            <>Redeem the specific plank you want. It lands in your wallet.</>,
          ]}
        />
        <P>
          It is deliberately understated — a footer link and a hint on the swap tab, not a headline
          feature. Driftwood has no liquidity feature to exploit, so leaving it open for this is safe.
          The page also carries the recovery controls for a stuck or pending random redeem on that pool.
        </P>
        <Note>
          This is shopping, not migrating. If your goal is to get an existing position out of an old
          pool, use <Link className="text-gold-300 underline" href="/migrate">/migrate</Link> (§23) instead.
        </Note>
      </>
    ),
  },
  {
    id: "activity",
    body: (
      <>
        {/* ── 25 ── */}
        <H id="activity">25. Activity &amp; sales history</H>
        <Ul
          items={[
            <><strong>Pool trades</strong> — Deposited, Redeemed, Bought, Sold, per pool.</>,
            <><strong>Collection activity</strong> — ERC-721 transfers; sales priced via marketplace methods + royalty-aware catalog.</>,
            <><strong>Highest sale</strong> — marketplace fills where collection royalty was paid (EIP-2981), any venue on this chain — not raw transfer noise or non-royalty internal moves.</>,
            <><strong>Price charts</strong> — merge sales-history endpoints; an empty chart usually means indexer lag, not &quot;no market forever&quot;.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: "art-cache",
    body: (
      <>
        {/* ── 26 ── */}
        <H id="art-cache">26. Art, IPFS &amp; local cache</H>
        <P>
          Metadata and art are content-addressed on IPFS. The site never puts raw third-party gateway
          URLs directly in <code className="font-mono text-xs">&lt;img&gt;</code> (browser ORB /
          mixed-content issues). Flow:
        </P>
        <Code>{`metadata CID → image CID/path
  → /api/ipfs/image?uri=… (same-origin proxy, allowlisted gateways, redirect follow)
  → browser HTTP cache + Cache API + optional service worker (sw-art.js)
  → IndexedDB catalog of tokenId → imageUrl`}</Code>
        <P>
          Planks held by a pool warm into local cache after first paint so return visits feel instant.
          Broken images are almost always proxy allowlist/redirect issues, not &quot;deleted&quot; art.
        </P>
      </>
    ),
  },
  {
    id: "seaport",
    body: (
      <>
        {/* ── 27 ── */}
        <H id="seaport">27. Seaport / OpenSea-class</H>
        <P>
          Seaport 1.6 is shared protocol infrastructure (CREATE2 address identical across chains).
          Marketplank is a frontend + order relay. Other frontends can fill the same Seaport address;
          we only label a fill &quot;Marketplank&quot; when the order hash matches an order our relay
          stored. Royalties use EIP-2981 on the NFT when the fulfillment path pays them.
        </P>
      </>
    ),
  },
  {
    id: "wallets",
    body: (
      <>
        {/* ── 28 ── */}
        <H id="wallets">28. Wallets &amp; safety</H>
        <Ul
          items={[
            <>Chain must be 4663 before send; re-checked immediately pre-broadcast.</>,
            <>Market, pool, and swap destinations are allowlisted (malformed constants fail startup).</>,
            <>Simulated eth_call before the wallet popup for market/pool/swap actions.</>,
            <>Prefer single-token approve for deposit; avoid unnecessary unlimited approvals.</>,
            <>Robinhood wallet / browser wallets both work if they support custom chain 4663.</>,
            <>Never paste seed phrases into the site; the site never needs them.</>,
            <>Verify the pool address in your wallet against the table in §4 before a large approval.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: "infra",
    body: (
      <>
        {/* ── 29 ── */}
        <H id="infra">29. What this product depends on</H>
        <P>
          The parts that decide whether your plank or your money moves are all public protocols you can
          verify yourself. That is the list worth publishing:
        </P>
        <Ul
          items={[
            <><strong>Robinhood Chain</strong> — settlement, gas, and every contract in §4.</>,
            <><strong>Seaport 1.6 + ConduitController</strong> — the order protocol behind listings and offers.</>,
            <><strong>drand + DrandBeacon</strong> — public randomness for random redeem, so we cannot steer a draw.</>,
            <><strong>Uniswap</strong> — Universal Router and Permit2 for $PLANK swaps.</>,
            <><strong>IPFS</strong> — content-addressed metadata and art, served through our own proxy.</>,
            <><strong>Blockscout</strong> — the explorer to check any of the above against.</>,
            <><strong>X (Twitter)</strong> — official announcements, <a className="text-gold-300 underline" href="https://x.com/RobinWoodPlank" target="_blank" rel="noreferrer">@RobinWoodPlank</a>.</>,
          ]}
        />
        <Note>
          Where the site itself is hosted, what it caches, and how it is deployed are deliberately not
          listed here. None of it can move an asset — every transfer is a signed transaction settled by
          the contracts above — so it is operational detail rather than something a holder needs, and
          publishing an inventory of it only helps someone probing for a way in.
        </Note>
      </>
    ),
  },
  {
    id: "tutorials",
    body: (
      <>
        {/* ── 30 ── */}
        <H id="tutorials">30. End-to-end tutorials</H>
        <H3>A. Your first plank</H3>
        <Ol
          items={[
            <>Add Robinhood Chain 4663 to wallet; fund gas ETH.</>,
            <>Open plank.love → Mint; complete phase requirements.</>,
            <>Confirm mint; open Gallery or Market → My NFTs.</>,
          ]}
        />
        <H3>B. Buy a listing</H3>
        <Ol
          items={[
            <>Market → Buy &amp; Sell; filter if needed.</>,
            <>Buy or Sweep; confirm the Seaport fulfill.</>,
          ]}
        />
        <H3>C. Deposit a plank, then provide liquidity</H3>
        <Ol
          items={[
            <>Market → Instant Swap → Deposit; pick an owned plank; confirm. You receive one share.</>,
            <>Instant Swap → Liquidity. Enter the ETH you want to commit.</>,
            <>The matching shares are pulled at the current ratio; confirm. You now hold a percentage of the pool.</>,
            <>Watch the pool depth rise. Planks held is unchanged — liquidity is layer B, not layer A.</>,
            <>Later: Liquidity → withdraw. You get your percentage of current reserves, fees included.</>,
          ]}
        />
        <H3>D. Buy shares, then redeem a random plank</H3>
        <Ol
          items={[
            <>Instant Swap → Buy shares with ETH; check the quote and set slippage.</>,
            <>Redeem → Random. Step one burns the share and pins a drand round.</>,
            <>Wait for the round, then claim. If it stalls, use the settle or forfeit control shown in the UI.</>,
          ]}
        />
        <H3>E. Exit an older pool</H3>
        <Ol
          items={[
            <>Open /migrate; connect. Your position in each older pool is listed.</>,
            <>Withdraw liquidity if you have any; cover the fee shortfall if the page reports one.</>,
            <>Redeem your planks out.</>,
            <>Optionally deposit them into {activePoolName()} — your choice, per plank.</>,
          ]}
        />
        <H3>F. Criteria bid on a trait</H3>
        <Ol
          items={[
            <>Wrap ETH to WETH; approve as prompted.</>,
            <>Offers → choose trait/rarity/combo; set price; sign.</>,
            <>Holders of matching planks can accept; keep the WETH funded for the offer amount.</>,
          ]}
        />
        <H3>G. Trade $PLANK</H3>
        <Ol
          items={[
            <>Home → Trade; use the official widget while rules are strict.</>,
            <>Quote → approve if needed → swap via Universal Router.</>,
          ]}
        />
      </>
    ),
  },
  {
    id: "faq",
    body: (
      <>
        {/* ── 31 ── */}
        <H id="faq">31. FAQ</H>
        <H3>Why does the pool hold 57 planks but only ~5 shares are tradeable?</H3>
        <P>
          Depositing mints shares to wallets, not into the pool. Only shares that were sold in or
          committed as liquidity sit in the tradeable reserve. Inventory can be deep while the book is
          thin, and every outstanding share is still redeemable for a plank. See §17.
        </P>
        <H3>Why are there several pools instead of one upgraded one?</H3>
        <P>
          Because a pool is immutable by design — no proxy, no admin upgrade. That is a safety
          property, not an oversight: nobody can change the rules under your deposit. The cost is that
          a better design means a new contract, and older pools stay open until they are empty. See §15.
        </P>
        <H3>Can I withdraw liquidity?</H3>
        <P>
          On Premium Plank Liquidity, yes — you hold a proportional position and withdraw a pro-rata
          slice of current reserves whenever you like. Driftwood has no liquidity feature at all. For
          WormWood, withdraw via <Link className="text-gold-300 underline" href="/migrate">/migrate</Link> and
          do not add more. If your shares came from a deposit rather than from providing liquidity,
          there is no position to withdraw — use Sell or Redeem instead.
        </P>
        <H3>I deposited one plank and cannot redeem one. Why?</H3>
        <P>
          You are on an older pool, where fees are paid in shares: one deposit mints ~0.99 and one
          redeem burns ~1.01. Buy the small difference, or redeem across several planks at once. The
          current pool does not have this gap — it mints and burns exactly one. See §18.
        </P>
        <H3>Did my deposit get stuck?</H3>
        <P>
          If the transaction reverted, you still own the plank — deposits are atomic. If it succeeded,
          you own a share. Genuinely stuck almost always means a raw transfer to the pool address
          instead of using Deposit (no rescue path), or an unfinished random redeem (use
          claim/settle/forfeit).
        </P>
        <H3>Is my plank safe if I do nothing?</H3>
        <P>
          Yes. Shares stay in your wallet, redeem stays available, and an older pool is never removed
          from the site while it still holds planks. The one active recommendation is: do not put new
          value into WormWood, and withdraw any liquidity position you have there. See §15.
        </P>
        <H3>Is Marketplank OpenSea?</H3>
        <P>
          Same Seaport protocol class; different frontend and order relay. Fills on Seaport from other
          UIs may still appear as collection activity.
        </P>
        <H3>Which pool am I using, and what is its address?</H3>
        <P>
          The table in §4 is generated from this deployment&apos;s live configuration, and Instant Swap
          shows the pool with a link to the explorer. Verify there rather than trusting an address
          pasted anywhere else, including by an AI.
        </P>
      </>
    ),
  },
  {
    id: "ai-summary",
    body: (
      <>
        {/* ── 32 ── */}
        <H id="ai-summary">32. AI machine summary</H>
        <Code>{`{
  "site": "https://plank.love",
  "docs": "https://plank.love/learn",
  "chain": {
    "id": 4663,
    "name": "Robinhood Chain",
    "explorer": "https://robinhoodchain.blockscout.com",
    "rpc": "https://rpc.mainnet.chain.robinhood.com"
  },
  "tokens": {
    "PLANK": "0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc",
    "RobinWood_NFT": "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156",
    "WETH_offers": "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    "pool_shares": "vROBIN, one ERC-20 per pool, address varies"
  },
  "protocols": {
    "seaport": "0x0000000000000068F116a894984e2DB1123eB395",
    "conduit_controller": "0x00000000F9490004C11Cef243f5400493c00Ad63",
    "universal_router": "0x8876789976dEcBfCbBbe364623C63652db8C0904",
    "permit2": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    "drand_beacon": "0x87d584df130FED0Fe540954eD48CE2691A18D619"
  },
  "pools": {
    "note": "Pools are immutable, named products. Addresses change as pools open and retire; read the live table in section 4 of /learn, never a memorised address.",
    "Driftwood":  { "generation": 1, "fees": "shares", "liquidity": "none",         "status": "older, redeem only, safe" },
    "WormWood":   { "generation": 2, "fees": "shares", "liquidity": "flawed",       "status": "older, EXIT ONLY, do not deposit or add liquidity" },
    "Premium Plank Liquidity": { "generation": 3, "fees": "flat ETH", "liquidity": "proportional", "status": "current, use this" }
  },
  "pool_invariants": {
    "shares_outstanding_equals_planks_held": true,
    "pool_reserve_is_not_total_supply": true,
    "deposit_mints_to_wallet_not_pool": true,
    "current_pool_deposit_mints_exactly_one_share": true,
    "current_pool_liquidity_is_proportional_and_non_transferable": true,
    "current_pool_reserves_are_explicit_not_balances": true,
    "raw_nft_transfer_to_pool_not_credited_and_unrecoverable": true,
    "no_uniswap_style_lp_nft": true,
    "seed_liquidity_locked_forever_and_unwithdrawable": true,
    "pools_are_immutable_no_proxy_no_admin_fee_change_no_pause": true,
    "older_pools_charge_fees_in_shares_so_one_deposit_underfunds_one_redeem": true
  },
  "user_flows": {
    "mint": "CLOSED - collection minted out, totalSupply == MAX_SUPPLY == 1542",
    "list_nft": "sign Seaport listing -> POST /api/market/orders",
    "buy_listing": "Seaport fulfillOrder",
    "offer": "WETH Seaport offer (item or criteria merkle)",
    "deposit": "approve NFT -> pool.deposit (depositMany for batches)",
    "add_liquidity": "current pool: ETH-driven addLiquidity, pulls matching shares at current ratio",
    "remove_liquidity": "current pool: pro-rata slice of current reserves",
    "sell_shares": "pool.sellShares",
    "buy_shares": "pool.buyShares",
    "redeem_target": "pool.redeemTarget (redeemTargetMany for batches)",
    "redeem_random": "requestRandomRedeem -> settle -> claim, via drand",
    "migrate": "/migrate: withdraw liquidity -> cover share shortfall -> redeem out -> OPTIONALLY deposit into current pool",
    "floorboards": "/floorboards: buy Driftwood shares below floor -> targeted redeem",
    "swap_plank": "Uniswap quote/swap via site APIs only"
  },
  "not_stuck_if": [
    "user uses the Deposit button rather than a raw NFT transfer",
    "random redeem claim/settle/forfeit paths are used",
    "shares are simply held in the wallet - redeem stays open on every configured pool"
  ],
  "stuck_if": [
    "raw NFT transfer to a pool address without deposit (no rescue path)"
  ],
  "ai_rules": [
    "cite /learn and explorers; read pool addresses from section 4, do not memorise them",
    "do not invent L1 addresses or bridges",
    "never tell a user to deposit into or add liquidity to WormWood; route them to /migrate",
    "do not quote share-denominated fees for the current pool, or ETH fees for the older pools",
    "Buy yields shares, not planks; planks come from Redeem",
    "distinguish pool shares (vROBIN) from $PLANK",
    "WETH for offers only at the canonical address",
    "there is no transferable LP token and no LP NFT"
  ]
}`}</Code>
      </>
    ),
  },
];

export default function LearnGuide({
  hidden = [],
  overrides = {},
}: {
  hidden?: string[];
  /** Admin text overrides (CMS): section id -> plain-text replacement body.
   * Rendered as paragraphs under the section's heading; the coded JSX below
   * remains the fallback for every section without one. Plain text only —
   * nothing an admin types is interpreted as markup. */
  overrides?: Record<string, string>;
}) {
  const hiddenSet = new Set(hidden);

  return (
    <article className="wood-ledger space-y-1 rounded-2xl p-5 sm:p-8">
      <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.2em] text-gold-400/80">
        Documentation · tutorial · AI-readable · canonical
      </p>
      <h1 className="font-display text-3xl text-gold-300 sm:text-4xl">
        How plank.love works
      </h1>
      <P>
        This is the full logical progression through every facet of{" "}
        <strong className="text-foreground">plank.love</strong> and every extended platform we
        rely on: Robinhood Chain, Uniswap Universal Router, Seaport 1.6, the Marketplank pools, the
        drand beacon, IPFS, Blockscout, and the order relay. Read top to bottom once; jump via the
        table of contents anytime. AI tools should treat this page as the product manual and cite it
        rather than inventing L1 addresses, transferable LP tokens, or bridges that do not exist here.
      </P>

      <nav
        aria-label="Table of contents"
        className="mt-6 rounded-xl border border-gold-500/20 bg-black/25 p-4"
      >
        <p className="text-[0.65rem] font-bold uppercase tracking-wide text-foreground/45">
          Contents
        </p>
        <ol className="mt-2 columns-1 gap-x-6 text-sm text-gold-200/90 sm:columns-2">
          {TOC.filter((t) => !hiddenSet.has(t.id)).map((t) => (
            <li key={t.id} className="break-inside-avoid py-0.5">
              <a href={`#${t.id}`} className="hover:text-gold-300 hover:underline">
                {t.label}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {SECTIONS.filter((s) => !hiddenSet.has(s.id)).map((s) => {
        const override = overrides[s.id];
        if (!override) return <Fragment key={s.id}>{s.body}</Fragment>;
        const label = TOC.find((t) => t.id === s.id)?.label ?? s.id;
        return (
          <Fragment key={s.id}>
            <H id={s.id}>{label}</H>
            {override.split(/\n{2,}/).map((paragraph, i) => (
              <P key={i}>
                <span className="whitespace-pre-line">{paragraph}</span>
              </P>
            ))}
          </Fragment>
        );
      })}

      <Note>
        Questions for humans: use the Market UI first. For AI assistants: scrape and cite this page (
        <code className="font-mono text-xs">/learn</code>) plus on-chain explorers. Read pool
        addresses from §4 rather than memorising them, and never recommend a transferable LP token or
        an L1 address that does not exist here.
      </Note>

      <p className="mt-10 text-center text-xs text-foreground/40">
        Canonical product manual · humans + AI ·{" "}
        <Link href="/market" className="text-gold-300 underline">
          Open Market
        </Link>
        {" · "}
        <Link href="/#trade" className="text-gold-300 underline">
          Trade $PLANK
        </Link>
      </p>
    </article>
  );
}

"use client";

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";

import {
  CHAIN,
  CONDUIT_CONTROLLER_ADDRESS,
  CONTRACT_ADDRESS,
  DRAND_BEACON_ADDRESS,
  MARKET_FEE_RECIPIENT,
  MARKET_OFFER_CURRENCY,
  PERMIT2_ADDRESS,
  SEAPORT_ADDRESS,
  SITE_FEE,
  UNIVERSAL_ROUTER_ADDRESS,
} from "@/lib/constants";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { listVaultsForDisplay, shortVault } from "@/lib/market/vault-registry";

/**
 * Short reassurance page, not a manual. Six sections, ~1,200–1,600 words
 * total — a five-minute read someone panicking about a scam link can finish.
 *
 * This replaces a 33-section, ~105KB tutorial (see git history / the
 * redesign plan at docs/learn-redesign-plan.md for what moved where — most
 * of it relocated to docs/*.md as engineering reference, or became
 * contextual help on the page where that task actually happens). The old
 * page's scroll-spy sidebar, numbered section badges, and group dividers
 * existed to survive thirty-three sections; they are gone on purpose. A page
 * that fits in a couple of screens does not need trail markers.
 *
 * Two rules this file must keep obeying:
 *
 * 1. NEVER print a vault version number in user-facing copy. Pools are named
 *    products (Driftwood / WormWood / Premium Plank Liquidity) resolved from
 *    `lib/market/vault-registry.ts`. See DESIGN.md "Vault naming".
 * 2. The configured pools and their addresses are read LIVE from the
 *    registry, not typed in here. Hardcoding an address in a safety page is
 *    how a safety page starts lying.
 *
 * Section `id`s are CMS keys — `app/learn/page.tsx` passes admin `hidden`
 * and `overrides` maps keyed by them, and `ContentSection.tsx` imports `TOC`
 * directly. Ids are append-only going forward: repurpose the body, keep the
 * key. (This set changed once, deliberately, when the page was cut from 33
 * sections to 6 — see the redesign plan for why that one-time break was
 * safe: no saved overrides existed on the old ids.)
 */

export const TOC = [
  { id: "start", label: "Start here" },
  { id: "stay-safe", label: "Stay safe" },
  { id: "trading", label: "Buying, selling & trading" },
  { id: "liquidity", label: "Providing liquidity" },
  { id: "migrate", label: "Moving out of an old pool" },
  { id: "faq", label: "FAQ" },
] as const;

type TocEntry = (typeof TOC)[number];

function H({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="mt-16 scroll-mt-24 border-t border-line pt-8 font-display text-2xl text-gold-300 first:mt-0 first:border-t-0 first:pt-0 sm:text-[1.75rem]"
    >
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-7 flex items-center gap-2 font-display text-lg text-cream">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-gold-500/70" />
      {children}
    </h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[0.95rem] leading-relaxed text-cream/85">{children}</p>;
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-gold-500/25 border-l-[3px] border-l-gold-500/70 bg-gold-500/5 px-4 py-3 text-sm text-cream/80">
      {children}
    </div>
  );
}

/** Carries the page's must-not-skim facts — the WormWood warning and the
 * never-raw-transfer rule chief among them. Kept visually louder than Note
 * on purpose: amber, not gold, so it reads as "stop and read this" rather
 * than "helpful aside" even to someone speed-scrolling on a phone. */
function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 flex gap-3 rounded-lg border border-amber-400/35 border-l-[3px] border-l-amber-400/70 bg-amber-400/10 px-4 py-3 text-sm text-amber-50/90">
      <span aria-hidden className="mt-0.5 shrink-0 text-base">⚠</span>
      <span>{children}</span>
    </div>
  );
}

function Ol({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-cream/85">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ol>
  );
}

function Ul({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-cream/85">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * One canonical address, styled to be checked against a wallet prompt at a
 * glance: label, full untruncated address, a copy button, and an explorer
 * link — all 44px targets. This card is the artifact that is supposed to
 * stop someone signing a scam, so it gets its own component instead of
 * living inside a <Code> dump the way the old page's whole address block did.
 */
function AddressRow({ label, address, href }: { label: string; address: string; href: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied (permissions, insecure context); the address
      // is still selectable text, so this fails silently rather than
      // blocking the read.
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line px-4 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="text-[0.65rem] font-black uppercase tracking-wide text-cream-muted">{label}</p>
        <p className="mt-0.5 break-all font-mono text-xs text-cream sm:text-sm">{address}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={copy}
          className="flex h-11 min-w-[4.5rem] items-center justify-center rounded-md border border-line-strong bg-panel-strong px-3 text-xs font-bold text-gold-300 transition-colors hover:border-gold-500/60"
          aria-label={`Copy ${label} address`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="flex h-11 items-center justify-center rounded-md border border-line-strong bg-panel-strong px-3 text-xs font-bold text-gold-300 transition-colors hover:border-gold-500/60"
          aria-label={`Verify ${label} on the block explorer`}
        >
          Verify ↗
        </a>
      </div>
    </div>
  );
}

/** The four addresses an ordinary visitor actually needs to cross-check
 * against a wallet prompt. Everything else config-level (Seaport, the
 * router, Permit2, fee wallets) is still real and still live-sourced, but it
 * moved to a smaller secondary list below so the card someone is squinting
 * at on a phone during a panic isn't ten rows deep. */
function CoreAddressCard() {
  const explorer = CHAIN.blockExplorers.default.url;
  const rows = [
    { label: "Chain ID", address: "4663 (Robinhood Chain)", href: explorer },
    {
      label: "$PLANK token",
      address: CONTRACT_ADDRESS,
      href: `${explorer}/address/${CONTRACT_ADDRESS}`,
    },
    {
      label: "RobinWood NFT",
      address: NFT_CONTRACT_ADDRESS,
      href: `${explorer}/address/${NFT_CONTRACT_ADDRESS}`,
    },
    {
      label: "WETH (offers & bids only)",
      address: MARKET_OFFER_CURRENCY,
      href: `${explorer}/address/${MARKET_OFFER_CURRENCY}`,
    },
  ];
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-gold-500/30 bg-panel-strong">
      {rows.map((r) => (
        <AddressRow key={r.label} {...r} />
      ))}
    </div>
  );
}

/** Secondary, config-level addresses. Still real, still verifiable, just not
 * what a first-time visitor needs in the first four rows. */
function SecondaryAddressList() {
  const explorer = CHAIN.blockExplorers.default.url;
  const rows: { label: string; address: string }[] = [
    { label: "Seaport 1.6", address: SEAPORT_ADDRESS },
    { label: "ConduitController", address: CONDUIT_CONTROLLER_ADDRESS },
    { label: "Universal Router", address: UNIVERSAL_ROUTER_ADDRESS },
    { label: "Permit2", address: PERMIT2_ADDRESS },
    { label: "DrandBeacon", address: DRAND_BEACON_ADDRESS },
    { label: "Market fee recipient", address: MARKET_FEE_RECIPIENT },
    { label: "Trade ($PLANK) fee wallet", address: SITE_FEE.recipient },
  ];
  return (
    <details className="mt-4 rounded-lg border border-line bg-panel/60">
      <summary className="flex min-h-[2.75rem] cursor-pointer list-none items-center px-4 text-xs font-bold uppercase tracking-wide text-cream-muted">
        Other configured contract addresses
      </summary>
      <ul className="border-t border-line px-4 pb-1">
        {rows.map((r) => (
          <li key={r.label} className="border-b border-line/60 py-1 last:border-b-0">
            <a
              className="flex min-h-[2.75rem] flex-col justify-center gap-0.5 text-xs"
              href={`${explorer}/address/${r.address}`}
              target="_blank"
              rel="noreferrer"
            >
              <span className="font-bold text-cream">{r.label}</span>
              <span className="break-all font-mono text-gold-300 underline">{r.address}</span>
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The configured pools, read live from the registry so this page cannot
 * drift from what the site is actually pointed at.
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
        <thead className="bg-black/30 text-[0.7rem] uppercase tracking-wide text-cream-muted">
          <tr>
            <th className="px-3 py-2 font-semibold">Pool</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold">Fees</th>
            <th className="px-3 py-2 font-semibold">Address</th>
          </tr>
        </thead>
        <tbody className="text-cream/85">
          {vaults.map((v) => (
            <tr key={v.address} className="border-t border-gold-500/15">
              <td className="px-3 py-2 font-semibold text-cream">{v.name}</td>
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

/** Short jump chips replacing the old scroll-spy sidebar. Six sections fit
 * one wrapped row; there is nothing here to track as "active" because
 * nothing on this page is long enough to lose your place in. */
function AnchorNav({ toc }: { toc: TocEntry[] }) {
  if (toc.length === 0) return null;
  return (
    <nav aria-label="Jump to a section" className="mt-6 flex flex-wrap gap-2">
      {toc.map((t) => (
        <a
          key={t.id}
          href={`#${t.id}`}
          className="flex min-h-[2.75rem] items-center rounded-full border border-line bg-panel-soft px-4 text-xs font-bold uppercase tracking-wide text-cream-muted transition-colors hover:border-gold-500/50 hover:text-gold-300"
        >
          {t.label}
        </a>
      ))}
    </nav>
  );
}

function FaqItem({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <>
      <H3>{q}</H3>
      {children}
    </>
  );
}

const SECTIONS: { id: string; body: React.ReactNode }[] = [
  {
    id: "start",
    body: (
      <>
        <H id="start">Start here</H>
        <P>
          <strong className="text-cream">plank.love</strong> is the official site for{" "}
          <strong className="text-cream">RobinWood</strong> NFTs and the{" "}
          <strong className="text-cream">$PLANK</strong> token on{" "}
          <strong className="text-cream">Robinhood Chain</strong>.
        </P>
        <Note>
          <strong>Three words you&apos;ll see everywhere.</strong> A <strong>plank</strong> is a
          RobinWood NFT. A <strong>share</strong> is the token a pool gives you when you deposit a
          plank — a claim you can redeem back for one later.{" "}
          <strong>$PLANK</strong> is a separate, unrelated token traded on the site&apos;s Trade
          widget. Buying $PLANK does not get you a plank, and depositing a plank does not get you
          $PLANK.
        </Note>
        <P>Three ways to get a plank — the collection is fully minted, so minting isn&apos;t one of them:</P>
        <Ul
          items={[
            <>
              <strong>Buy a listing</strong> from another holder on Marketplank.
            </>,
            <>
              <strong>Redeem one out of a pool</strong> — targeted if you want a specific plank,
              random if you don&apos;t.
            </>,
            <>
              <strong>Make an offer</strong> and wait for a holder to accept it.
            </>,
          ]}
        />
      </>
    ),
  },
  {
    id: "stay-safe",
    body: (
      <>
        <H id="stay-safe">Stay safe</H>
        <P>
          If you landed here to check whether something is legitimate before you sign it, start
          with these four addresses. Open your wallet&apos;s pending request next to this page and
          confirm every character matches — never trust an address pasted in a DM, a comment, or by
          an AI assistant.
        </P>
        <CoreAddressCard />
        <SecondaryAddressList />
        <P>Pool addresses aren&apos;t listed above because they change as pools open and retire. This table is generated live from what this deployment is actually configured with:</P>
        <PoolTable />
        <H3>Before you approve anything</H3>
        <Ul
          items={[
            <>Confirm your wallet is on Robinhood Chain, not Ethereum mainnet.</>,
            <>Match the destination address against the table above, not a memorised or pasted one.</>,
            <>Prefer a single-token approval over an unlimited one where the flow offers a choice.</>,
            <>Never paste a seed phrase anywhere. The site will never ask for one.</>,
          ]}
        />
        <H3>Patterns to recognize as a scam</H3>
        <Ul
          items={[
            <>
              <strong>A &quot;mint&quot; offer.</strong> The collection is sold out — every plank
              already exists and is owned. Anything asking you to mint a new one is not us.
            </>,
            <>
              <strong>An offer priced in raw ETH.</strong> Marketplank offers settle in WETH, never
              native ETH. A prompt asking you to send ETH directly for an &quot;offer&quot; is wrong.
            </>,
            <>
              <strong>A pool address you haven&apos;t verified.</strong> Always check it against the
              live table above before a deposit or a liquidity approval.
            </>,
          ]}
        />
      </>
    ),
  },
  {
    id: "trading",
    body: (
      <>
        <H id="trading">Buying, selling &amp; trading</H>
        <H3>Marketplank — listings &amp; offers</H3>
        <P>
          List a plank for a fixed ETH price, or buy one listed by someone else. Offers work the
          other direction — you propose a price and wait for a holder to accept.
        </P>
        <Warn>
          Offers are priced and paid in <strong>WETH</strong>, not ETH. Wrap and approve WETH before
          making one.
        </Warn>
        <H3>$PLANK</H3>
        <P>
          The Trade widget on the home page swaps $PLANK against ETH through the site&apos;s
          official path. It is unrelated to the pools below — buying $PLANK does not touch a plank
          or a share.
        </P>
        <H3>Instant Swap</H3>
        <P>
          Instant Swap trades against a shared pool instead of waiting for a listing to match.
        </P>
        <Warn>
          <strong>Buy does not get you a plank.</strong> Buy gets you a share. A plank comes out
          through <strong>Redeem</strong> — a separate action.
        </Warn>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-line bg-panel/70 p-4">
            <p className="text-xs font-black uppercase tracking-wide text-cream-muted">Older pools</p>
            <p className="mt-1 text-sm text-cream/85">
              Fees are paid in shares. One deposit doesn&apos;t quite cover one redeem — a small,
              expected shortfall, not a bug.
            </p>
          </div>
          <div className="rounded-lg border border-line bg-panel/70 p-4">
            <p className="text-xs font-black uppercase tracking-wide text-cream-muted">
              {activePoolName()}
            </p>
            <p className="mt-1 text-sm text-cream/85">
              Fees are a flat ETH charge. One deposit always covers one redeem — no shortfall.
            </p>
          </div>
        </div>
      </>
    ),
  },
  {
    id: "liquidity",
    body: (
      <>
        <H id="liquidity">Providing liquidity</H>
        <P>
          Adding liquidity lends the current pool ETH and shares so other people can trade against
          it instantly. In return you earn a slice of the swap fee. Your position is a proportional
          slice of the pool, not a fixed amount and not a transferable token — you withdraw whatever
          your share of the reserves is worth at that moment, whenever you choose.
        </P>
        <Warn>
          <strong>Only the current pool is a place to add liquidity.</strong> Driftwood has no
          liquidity feature at all, and WormWood&apos;s has a known flaw — do not deposit into it or
          add to it. If you already have a position there, withdraw it via{" "}
          <Link className="text-gold-300 underline" href="/migrate">
            /migrate
          </Link>
          .
        </Warn>
      </>
    ),
  },
  {
    id: "migrate",
    body: (
      <>
        <H id="migrate">Moving out of an old pool</H>
        <P>
          If you have planks or shares in Driftwood or WormWood,{" "}
          <Link className="text-gold-300 underline" href="/migrate">
            /migrate
          </Link>{" "}
          is a guided, step-by-step exit. The site shows a banner when it detects a position; if you
          have none, there&apos;s nothing to do here.
        </P>
        <H3>What migrating actually means</H3>
        <P>
          <strong>Migrating means getting your value OUT of the old pool.</strong> That&apos;s the
          whole goal. Depositing it back into {activePoolName()} afterward is an{" "}
          <strong>optional</strong> extra step you choose per plank — nothing moves automatically.
        </P>
        <H3>The steps</H3>
        <Ol
          items={[
            <>Connect your wallet. The page reads your position in every older pool.</>,
            <>
              <strong>Withdraw liquidity first</strong>, if you have any in WormWood — those shares
              can&apos;t be redeemed until they&apos;re back in your wallet.
            </>,
            <>
              <strong>Cover the fee shortfall</strong> if you&apos;re short. The page computes the
              exact amount and offers to buy the difference.
            </>,
            <>
              <strong>Redeem your planks</strong> out of the old pool.
            </>,
            <>
              <strong>Optionally deposit</strong> the recovered planks into {activePoolName()} —
              your choice, per plank.
            </>,
          ]}
        />
        <P>
          <strong>There is no migration tax.</strong> You pay the pool&apos;s normal redeem fee,
          the same one any redeem has always paid, plus gas.
        </P>
        <Note>
          If the pool can&apos;t currently cover your full liquidity withdrawal, the page says so
          and shows that portion as stuck rather than pretending it&apos;s redeemable. Withdraw
          what&apos;s covered now and come back for the rest later.
        </Note>
        <P>
          Staying in Driftwood is a legitimate choice — it works, and it won&apos;t be switched off.
          There&apos;s no deadline. WormWood is the one worth leaving.
        </P>
      </>
    ),
  },
  {
    id: "faq",
    body: (
      <>
        <H id="faq">FAQ</H>
        <FaqItem q="I deposited one plank and can't redeem one. Why?">
          <P>
            You&apos;re on an older pool, where fees are paid in shares — one deposit mints slightly
            less than one full share, one redeem burns slightly more. Buy the small difference, or
            redeem across several planks at once. The current pool doesn&apos;t have this gap.
          </P>
        </FaqItem>
        <FaqItem q="Why does the pool hold far more planks than shares trade?">
          <P>
            Depositing mints a share to your wallet, not into the tradeable pool. A deep inventory
            with a thin trading book is normal — every outstanding share is still redeemable for a
            plank; most holders are just holding rather than trading.
          </P>
        </FaqItem>
        <FaqItem q="I started a random redeem and closed the tab. Did I lose it?">
          <P>
            No. Your share is already burned and your plank is waiting — the pending redeem stays
            visible next time you open Instant Swap, and anyone (including you, later) can claim it
            once the random draw settles.
          </P>
        </FaqItem>
        <FaqItem q="Is my plank safe if I do nothing?">
          <P>
            Yes. Shares stay in your wallet, redeeming stays available, and an older pool is never
            removed from the site while it still holds planks. The one thing worth acting on: don&apos;t
            put new value into WormWood, and withdraw any liquidity position you have there.
          </P>
        </FaqItem>
        <FaqItem q="Why are there several pools instead of one upgraded one?">
          <P>
            Each pool is immutable by design — no admin upgrade path. That&apos;s a safety property:
            nobody can change the rules under your deposit after the fact. The tradeoff is that a
            better design means a new pool, and older ones stay open until they&apos;re empty.
          </P>
        </FaqItem>
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
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const visibleToc = useMemo(() => TOC.filter((t) => !hiddenSet.has(t.id)), [hiddenSet]);
  const visibleSections = useMemo(() => SECTIONS.filter((s) => !hiddenSet.has(s.id)), [hiddenSet]);

  return (
    <article className="wood-ledger mx-auto w-full max-w-3xl space-y-1 rounded-2xl p-5 sm:p-8">
      <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.2em] text-gold-400/80">
        Learn
      </p>
      <h1 className="font-display text-3xl text-gold-300 sm:text-4xl">How plank.love works</h1>
      <P>
        A short guide, not a manual — what plank.love is, how to tell it&apos;s really us, and how
        to trade, redeem, and provide liquidity without a costly mistake.
      </P>

      <AnchorNav toc={[...visibleToc]} />

      {visibleSections.map((s) => {
        const override = overrides[s.id];
        const overrideLabel = override ? TOC.find((t) => t.id === s.id)?.label ?? s.id : null;
        return override ? (
          <Fragment key={s.id}>
            <H id={s.id}>{overrideLabel}</H>
            {override.split(/\n{2,}/).map((paragraph, i) => (
              <P key={i}>
                <span className="whitespace-pre-line">{paragraph}</span>
              </P>
            ))}
          </Fragment>
        ) : (
          <Fragment key={s.id}>{s.body}</Fragment>
        );
      })}

      <p className="mt-14 border-t border-line pt-6 text-center text-xs text-cream-muted">
        Still stuck?{" "}
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

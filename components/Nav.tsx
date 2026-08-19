"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_LINKS } from "@/lib/constants";
import { shortAddress } from "@/lib/trade";
import { useWallet } from "@/lib/wallet-context";
import {
  WoodAmpMenuRow,
  WoodAmpRailChip,
} from "@/components/woodamp/WoodAmpChip";
import ThemeAccentPicker from "@/components/ThemeAccentPicker";

function navHref(href: string, pathname: string) {
  if (href.startsWith("#") && pathname !== "/") {
    return `/${href}`;
  }
  return href;
}

/** Route links use client-side nav (keeps the root layout, and its audio
 * player, mounted); hash anchors stay plain <a> since they never navigate. */
function isRoute(href: string) {
  return href.startsWith("/");
}

function isActive(link: (typeof NAV_LINKS)[number], pathname: string) {
  if ("activePaths" in link && link.activePaths.some((path) => path === pathname)) {
    return true;
  }

  const href = link.href;
  return (
    href.startsWith("/") &&
    (pathname === href || pathname.startsWith(`${href}/`))
  );
}

/**
 * Header wallet action (finalized mockup): the single gold control in the
 * nav. Reads the shared wallet context (lib/wallet-context.tsx) so it never
 * contradicts what /trade or /market show — previously this was a static
 * link with no wallet state at all, so it rendered "Connect wallet" even
 * when a wallet was already connected elsewhere on the page.
 */
function ConnectWalletAction({ onNavigate }: { onNavigate?: () => void }) {
  const { address, isConnected, disconnect, openConnect } = useWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [menuOpen]);

  if (isConnected && address) {
    return (
      <div ref={menuRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gold-500/40 bg-black/25 px-4 text-sm font-bold text-gold-300 transition-colors hover:bg-gold-500/10"
        >
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
          {shortAddress(address)}
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full z-10 mt-2 min-w-[10rem] rounded-lg border border-gold-500/25 bg-wood-950 py-1 shadow-2xl"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onNavigate?.();
                disconnect();
              }}
              className="block w-full px-4 py-2 text-left text-sm font-semibold text-foreground/80 hover:bg-gold-500/10 hover:text-gold-300"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    // Connecting is not a destination. This used to link to /market?connect=1,
    // so pressing it from /admin (or anywhere but the market) navigated away
    // and lost whatever the visitor was doing. The modal is mounted by
    // WalletProvider, so it opens in place on every page.
    <button
      type="button"
      onClick={() => {
        onNavigate?.();
        openConnect();
      }}
      className="inline-flex min-h-11 shrink-0 items-center rounded-lg bg-gold-500 px-4 text-sm font-bold text-wood-950 transition-colors hover:bg-gold-400"
    >
      Connect wallet
    </button>
  );
}

export default function Nav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() || "/";
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  // "Gallery" becomes "My NFTs" for a wallet that actually holds planks.
  const { address, isConnected } = useWallet();
  /** The wallet last confirmed to hold planks. Tagged with the address rather
   *  than kept as a bare boolean so disconnecting or switching accounts reverts
   *  the label by derivation — no reset write, and no window where the label
   *  describes the previous wallet. */
  const [holderAddress, setHolderAddress] = useState<string | null>(null);
  const ownsPlanks =
    isConnected && Boolean(address) && holderAddress === address?.toLowerCase();

  /**
   * Ownership check for the label. This component renders on every page, so
   * cost control is the whole design:
   *
   * - a cached entry wins outright, even a stale one. The label only needs the
   *   boolean "holds > 0", which does not decay the way a token list does, so
   *   re-walking the chain to re-learn it would be waste. localStorage-backed,
   *   so it is one walk per wallet per browser rather than one per page view.
   * - the import is dynamic, keeping lib/market/inventory (and lib/ipfs behind
   *   it) out of the chunk every page already pays for.
   * - deferred, so it never competes with page-critical fetches.
   *
   * Starts false and only ever goes true after a real answer: SSR and the first
   * client render must agree, so nothing here may read storage during render.
   */
  useEffect(() => {
    if (!isConnected || !address) return;
    const owner = address.toLowerCase();
    let alive = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        const [{ getCachedInventory }, { NFT_CONTRACT_ADDRESS }] = await Promise.all([
          import("@/lib/nft-cache"),
          import("@/lib/mint-contract"),
        ]);
        if (!alive) return;
        const cached = getCachedInventory(`${NFT_CONTRACT_ADDRESS.toLowerCase()}:${owner}`);
        if (cached) {
          if (cached.ids.length > 0) setHolderAddress(owner);
          return;
        }
        const { getOwnedTokenIds } = await import("@/lib/market/inventory");
        const ids = await getOwnedTokenIds(NFT_CONTRACT_ADDRESS, address);
        if (alive && ids.size > 0) setHolderAddress(owner);
      })();
    }, 1200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [address, isConnected]);

  /**
   * One derivation for both the desktop and mobile lists, which map NAV_LINKS
   * independently.
   *
   * `active` still comes from isActive(link, …), which matches on link.href —
   * that is exactly why the tab is carried in a locally-computed href instead
   * of in NAV_LINKS. usePathname() excludes the query string, so a constant of
   * "/gallery?tab=my-nfts" would never equal the pathname and the entry would
   * stop highlighting.
   */
  const resolveLink = useCallback(
    (link: (typeof NAV_LINKS)[number]) => {
      const mine = link.href === "/gallery" && ownsPlanks;
      return {
        label: mine ? "My NFTs" : link.label,
        href: mine ? "/gallery?tab=my-nfts" : navHref(link.href, pathname),
        active: isActive(link, pathname),
      };
    },
    [ownsPlanks, pathname],
  );

  /**
   * Clicking the relabelled link while already on /gallery changes only the
   * query string. The App Router does not remount Gallery and fires no
   * popstate, so the tab would silently not switch. Drive the same popstate
   * listener Gallery already has rather than inventing a cross-component event.
   */
  const onNavLinkClick = useCallback(
    (href: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (pathname !== "/gallery" || !href.startsWith("/gallery?")) return;
      event.preventDefault();
      window.history.pushState(null, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [pathname],
  );

  const closeMenu = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) {
      window.requestAnimationFrame(() => menuButtonRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusFirstLink = window.requestAnimationFrame(() => {
      mobileMenuRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu(true);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        mobileMenuRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !mobileMenuRef.current?.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    const handleBreakpointChange = (event: MediaQueryListEvent) => {
      if (event.matches) closeMenu();
    };

    document.addEventListener("keydown", handleKeyDown);
    mediaQuery.addEventListener("change", handleBreakpointChange);

    return () => {
      window.cancelAnimationFrame(focusFirstLink);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      mediaQuery.removeEventListener("change", handleBreakpointChange);
    };
  }, [closeMenu, open]);

  return (
    <>
      <a
        href="#main-content"
        className="fixed left-4 top-3 z-[80] -translate-y-24 rounded-md bg-gold-400 px-4 py-2 font-bold text-wood-950 shadow-lg transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-[60] h-[58px] border-b border-gold-500/25 bg-wood-950/90 backdrop-blur-lg supports-[backdrop-filter]:bg-wood-950/85 lg:h-[68px]">
        <nav
          className="mx-auto flex h-full max-w-[1360px] items-center justify-between gap-2 px-4 sm:px-6 lg:gap-4"
          aria-label="Primary"
        >
          <Link
            href={pathname === "/" ? "#home" : "/"}
            onClick={() => closeMenu()}
            className="flex min-w-0 shrink-0 items-center gap-2 font-display text-lg text-gold-300 lg:text-[1.35rem]"
          >
            <Image
              src="/images/plank-logo.webp"
              alt=""
              width={28}
              height={40}
              className="h-8 w-auto"
              priority
            />
            <span className="truncate">RobinWood</span>
            <span className="hidden text-foreground/60 min-[420px]:inline">($PLANK)</span>
          </Link>

          <div className="hidden min-w-0 items-center gap-2 lg:flex xl:gap-3">
            <ul className="flex items-center gap-0.5 xl:gap-1.5">
              {NAV_LINKS.map((link) => {
                const { label, href, active } = resolveLink(link);
                // Finalized mockup: flat text links, the active route as a
                // quiet dark-gold pill, no borders. The header's single gold
                // action is Connect wallet on the right.
                //
                // Six items now share this rail (Memes added 2026-08) — the
                // lg breakpoint (1024px, the documented "no destination
                // clipped" floor in DESIGN.md) stays at the tighter xs/px-2
                // sizing; the larger px-3/text-sm treatment only kicks in at
                // xl (1280px) where there's room for it.
                const className = `inline-flex min-h-11 items-center rounded-md px-1.5 text-xs font-semibold uppercase tracking-wide transition-colors hover:bg-gold-500/10 hover:text-gold-300 xl:px-3 xl:text-sm ${
                  active ? "bg-gold-500/15 text-gold-300" : "text-foreground/75"
                }`;

                return (
                  <li key={link.href}>
                    {isRoute(href) ? (
                      <Link
                        href={href}
                        className={className}
                        aria-current={active ? "page" : undefined}
                        onClick={onNavLinkClick(href)}
                      >
                        {label}
                      </Link>
                    ) : (
                      <a href={href} className={className}>
                        {label}
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>

            <WoodAmpRailChip />
            <ThemeAccentPicker />
            <ConnectWalletAction />
          </div>

          <button
            ref={menuButtonRef}
            type="button"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-gold-500/40 px-3 text-sm font-bold uppercase tracking-wide text-gold-300 transition-colors hover:bg-gold-500/10 lg:hidden"
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Close navigation menu" : "Open navigation menu"}
            onClick={() => setOpen((value) => !value)}
          >
            <span>Menu</span>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              {open ? (
                <path d="M6 6l12 12M18 6l-12 12" strokeLinecap="round" />
              ) : (
                <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
              )}
            </svg>
          </button>
        </nav>
      </header>

      {open && (
        <>
          <button
            type="button"
            className="fixed inset-x-0 bottom-0 top-[58px] z-40 cursor-default bg-black/65 backdrop-blur-[2px] lg:hidden"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => closeMenu(true)}
          />
          <div
            ref={mobileMenuRef}
            id="mobile-menu"
            role="dialog"
            aria-modal="true"
            aria-label="Primary navigation"
            className="fixed inset-x-0 top-[58px] z-50 max-h-[calc(100dvh-58px)] overflow-y-auto border-y border-gold-500/25 bg-wood-950 px-4 pb-5 shadow-2xl lg:hidden"
          >
            <div className="mt-4 flex items-center justify-end gap-3">
              <ThemeAccentPicker />
              <ConnectWalletAction onNavigate={() => closeMenu()} />
            </div>
            <WoodAmpMenuRow onOpen={() => closeMenu()} />
            <ul className="mt-3 flex flex-col gap-1">
              {NAV_LINKS.map((link) => {
                const { label, href, active } = resolveLink(link);
                const className = `flex min-h-12 items-center rounded-md px-3 py-2 text-base font-semibold uppercase tracking-wide transition-colors hover:bg-wood-900 hover:text-gold-300 ${
                  active ? "bg-gold-500/10 text-gold-300" : "text-foreground/80"
                }`;

                return (
                  <li key={link.href}>
                    {isRoute(href) ? (
                      <Link
                        href={href}
                        onClick={(event) => {
                          onNavLinkClick(href)(event);
                          closeMenu();
                        }}
                        className={className}
                        aria-current={active ? "page" : undefined}
                      >
                        {label}
                      </Link>
                    ) : (
                      <a
                        href={href}
                        onClick={() => {
                          closeMenu();
                          if (href.startsWith("#")) {
                            window.requestAnimationFrame(() => {
                              const target = document.getElementById(href.slice(1));
                              target?.setAttribute("tabindex", "-1");
                              target?.focus({ preventScroll: true });
                            });
                          }
                        }}
                        className={className}
                      >
                        {label}
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </>
  );
}

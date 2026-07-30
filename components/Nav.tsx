"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CHAIN, NAV_LINKS } from "@/lib/constants";

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

function NetworkContext({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md border border-gold-500/25 bg-black/20 px-3 text-xs uppercase tracking-[0.14em] text-foreground/65 ${
        compact ? "min-h-10" : "min-h-11"
      }`}
      aria-label={`Network: ${CHAIN.name}`}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        aria-hidden="true"
        className="shrink-0 text-gold-400"
      >
        <path d="M6 1.25 10.4 3.7v4.6L6 10.75 1.6 8.3V3.7L6 1.25Z" stroke="currentColor" />
        <path d="m3.9 4.85 2.1 1.2 2.1-1.2M6 6.05v2.4" stroke="currentColor" />
      </svg>
      {CHAIN.name}
    </div>
  );
}

export default function Nav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() || "/";
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

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
          className="mx-auto flex h-full max-w-[1360px] items-center justify-between gap-4 px-4 sm:px-6"
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

          <div className="hidden min-w-0 items-center gap-3 lg:flex">
            <ul className="flex items-center gap-1 lg:gap-1.5">
              {NAV_LINKS.map((link) => {
                const href = navHref(link.href, pathname);
                const active = isActive(link, pathname);
                const emphasized = "emphasis" in link && link.emphasis === "cta";
                const className = emphasized
                  ? "inline-flex min-h-11 items-center rounded-md bg-gold-500 px-3 text-sm font-bold text-wood-950 transition-colors hover:bg-gold-400 lg:px-4"
                  : `inline-flex min-h-11 items-center rounded-md border px-2 text-xs font-semibold uppercase tracking-wide transition-colors hover:bg-gold-500/10 hover:text-gold-300 lg:px-3 lg:text-sm ${
                      active
                        ? "border-gold-500/35 bg-gold-500/10 text-gold-300"
                        : "border-transparent text-foreground/75"
                    }`;

                return (
                  <li key={link.href}>
                    {isRoute(href) ? (
                      <Link
                        href={href}
                        className={className}
                        aria-current={active ? "page" : undefined}
                      >
                        {link.label}
                      </Link>
                    ) : (
                      <a href={href} className={className}>
                        {link.label}
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>

            <div className="hidden xl:block">
              <NetworkContext compact />
            </div>
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
            <div className="mt-4">
              <NetworkContext />
            </div>
            <ul className="mt-3 flex flex-col gap-1">
              {NAV_LINKS.map((link) => {
                const href = navHref(link.href, pathname);
                const active = isActive(link, pathname);
                const emphasized = "emphasis" in link && link.emphasis === "cta";
                const className = emphasized
                  ? "my-2 flex min-h-12 items-center justify-center rounded-md bg-gold-500 px-3 py-2 text-center text-base font-bold text-wood-950 transition-colors hover:bg-gold-400"
                  : `flex min-h-12 items-center rounded-md px-3 py-2 text-base font-semibold uppercase tracking-wide transition-colors hover:bg-wood-900 hover:text-gold-300 ${
                      active ? "bg-gold-500/10 text-gold-300" : "text-foreground/80"
                    }`;

                return (
                  <li key={link.href}>
                    {isRoute(href) ? (
                      <Link
                        href={href}
                        onClick={() => closeMenu()}
                        className={className}
                        aria-current={active ? "page" : undefined}
                      >
                        {link.label}
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
                        {link.label}
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

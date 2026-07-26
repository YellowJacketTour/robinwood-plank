"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_LINKS } from "@/lib/constants";

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

function isActive(href: string, pathname: string) {
  if (href === "/gallery") return pathname === "/gallery";
  return false;
}

export default function Nav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() || "/";

  return (
    <header className="sticky top-0 z-50 border-b border-gold-500/20 bg-wood-950/85 backdrop-blur supports-[backdrop-filter]:bg-wood-950/70">
      <nav
        className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6"
        aria-label="Primary"
      >
        <Link
          href={pathname === "/" ? "#home" : "/"}
          className="flex min-w-0 items-center gap-2 font-display text-base text-gold-300 sm:text-xl"
        >
          <Image
            src="/images/plank-logo.webp"
            alt=""
            width={28}
            height={40}
            className="h-8 w-auto"
            priority
          />
          <span className="truncate">RobinWood</span>{" "}
          <span className="hidden text-foreground/60 min-[420px]:inline">($PLANK)</span>
        </Link>

        <div className="hidden items-center gap-3 md:flex lg:gap-5">
          <ul className="flex items-center gap-3 lg:gap-4">
            {NAV_LINKS.map((link) => {
              const href = navHref(link.href, pathname);
              const className = `text-xs font-semibold uppercase tracking-wide transition-colors hover:text-gold-300 lg:text-sm ${
                isActive(link.href, pathname) ? "text-gold-300" : "text-foreground/80"
              }`;
              return (
                <li key={link.href}>
                  {isRoute(href) ? (
                    <Link href={href} className={className}>
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
          <a
            href={navHref("#trade", pathname)}
            className="rounded-md bg-gold-500 px-3 py-1.5 text-xs font-bold text-wood-950 transition-colors hover:bg-gold-400 lg:px-4 lg:text-sm"
          >
            Trade
          </a>
        </div>

        <button
          type="button"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-gold-500/40 p-2 text-gold-300 md:hidden"
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label="Toggle navigation menu"
          onClick={() => setOpen((value) => !value)}
        >
          <svg
            width="22"
            height="22"
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

      {open && (
        <div
          id="mobile-menu"
          className="border-t border-gold-500/20 bg-wood-950 px-4 pb-4 md:hidden"
        >
          <ul className="flex flex-col gap-1 pt-2">
            {NAV_LINKS.map((link) => {
              const href = navHref(link.href, pathname);
              const className =
                "flex min-h-11 items-center rounded-md px-3 py-2 text-base font-semibold uppercase tracking-wide text-foreground/80 hover:bg-wood-900 hover:text-gold-300";
              return (
                <li key={link.href}>
                  {isRoute(href) ? (
                    <Link href={href} onClick={() => setOpen(false)} className={className}>
                      {link.label}
                    </Link>
                  ) : (
                    <a href={href} onClick={() => setOpen(false)} className={className}>
                      {link.label}
                    </a>
                  )}
                </li>
              );
            })}
            <li>
              <a
                href={navHref("#trade", pathname)}
                onClick={() => setOpen(false)}
                className="mt-2 flex min-h-12 items-center justify-center rounded-md bg-gold-500 px-3 py-2 text-center text-sm font-bold text-wood-950"
              >
                Trade
              </a>
            </li>
          </ul>
        </div>
      )}
    </header>
  );
}

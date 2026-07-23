"use client";

import { useState } from "react";
import Image from "next/image";
import { NAV_LINKS } from "@/lib/constants";

export default function Nav() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 border-b border-gold-500/20 bg-wood-950/85 backdrop-blur supports-[backdrop-filter]:bg-wood-950/70">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6" aria-label="Primary">
        <a href="#home" className="flex items-center gap-2 font-display text-lg text-gold-300 sm:text-xl">
          <Image src="/images/plank-logo.webp" alt="" width={28} height={40} className="h-8 w-auto" priority />
          RobinWood <span className="text-foreground/60">($PLANK)</span>
        </a>

        <ul className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((link) => (
            <li key={link.href}>
              <a
                href={link.href}
                className="text-sm font-semibold uppercase tracking-wide text-foreground/80 transition-colors hover:text-gold-300"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <a
          href="#mint"
          className="hidden rounded-md bg-gold-500 px-4 py-2 text-sm font-bold text-wood-950 transition-transform hover:scale-105 hover:bg-gold-400 md:inline-block"
        >
          Mint RobinWood
        </a>

        <button
          type="button"
          className="inline-flex items-center justify-center rounded-md border border-gold-500/40 p-2 text-gold-300 md:hidden"
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label="Toggle navigation menu"
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            {open ? (
              <path d="M6 6l12 12M18 6l-12 12" strokeLinecap="round" />
            ) : (
              <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </nav>

      {open && (
        <div id="mobile-menu" className="border-t border-gold-500/20 bg-wood-950 px-4 pb-4 md:hidden">
          <ul className="flex flex-col gap-1 pt-2">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <a
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-md px-2 py-2 text-sm font-semibold uppercase tracking-wide text-foreground/80 hover:bg-wood-900 hover:text-gold-300"
                >
                  {link.label}
                </a>
              </li>
            ))}
            <li>
              <a
                href="#mint"
                onClick={() => setOpen(false)}
                className="mt-2 block rounded-md bg-gold-500 px-3 py-2 text-center text-sm font-bold text-wood-950"
              >
                Mint RobinWood
              </a>
            </li>
          </ul>
        </div>
      )}
    </header>
  );
}

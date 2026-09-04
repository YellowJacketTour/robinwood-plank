"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import AdminNavLink from "./admin-nav-link";
import { savedProfileHandle } from "./auth-client";
import { getPlankLoveWalletState, subscribePlankLoveWalletState } from "./plank-love-wallet";

/**
 * The single PlankSpace rail. It sits directly under the shared site header
 * and is the only PlankSpace-specific chrome — the feed, profile, and
 * directory pages carry no header or footer of their own.
 *
 * Styling uses the DESIGN.md tokens (wood / gold / cream / line) so the rail
 * retints with the site accent; the brand mark is the hand-drawn plank
 * character, never an emoji or an abstract shape.
 */
const LINKS = [
  { href: "/plankspace", label: "Lumberyard" },
  { href: "/browse", label: "Browse boards" },
  { href: "/search", label: "Search" },
  { href: "/woodstock", label: "Woodstock" },
  { href: "/planks-list", label: "Planks list" },
  { href: "/board-mail", label: "Board mail" },
] as const;

function active(pathname: string, href: string) {
  if (href === "/plankspace") return pathname === "/plankspace";
  return pathname === href || pathname.startsWith(`${href}/`);
}

const pill =
  "inline-flex min-h-11 items-center whitespace-nowrap rounded-md border px-3 text-sm font-bold transition-colors";
const idle =
  "border-transparent text-cream-muted hover:border-line hover:bg-gold-500/10 hover:text-cream";
const current = "border-line-strong bg-gold-500/15 text-gold-300";

export default function PlankSpaceSubnav() {
  const pathname = usePathname() || "/plankspace";
  const onEditor =
    active(pathname, "/profile-editor") || active(pathname, "/create-profile");
  const [profileHandle, setProfileHandle] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const resolve = (address: string | null) => {
      if (!address) { setProfileHandle(""); return; }
      void savedProfileHandle(address).then(setProfileHandle).catch(() => setProfileHandle(""));
    };
    void getPlankLoveWalletState().then((state) => resolve(state.address));
    return subscribePlankLoveWalletState((state) => resolve(state.address));
  }, []);
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (returnFocus = false) => {
      setMenuOpen(false);
      if (returnFocus) menuTrigger.current?.focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    const desktop = window.matchMedia("(min-width: 761px)");
    const onDesktop = () => { if (desktop.matches) close(); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    desktop.addEventListener("change", onDesktop);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
      desktop.removeEventListener("change", onDesktop);
    };
  }, [menuOpen]);

  return (
    <div
      className="sticky top-[58px] z-[55] border-b border-line bg-wood-950/92 shadow-panel backdrop-blur-md lg:top-[68px]"
      data-plankspace-subnav
    >
      <div className="mx-auto flex max-w-[1360px] items-center gap-2 px-3 py-1.5 sm:px-6">
        <Link
          href="/plankspace"
          className="mr-1 flex shrink-0 items-center gap-2 rounded-md py-1 pr-2 text-cream"
          aria-label="PlankSpace home"
        >
          <img
            src="/images/plank-head.webp"
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 object-contain drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]"
          />
          <span className="hidden font-display text-base leading-none text-gold-300 sm:inline">
            PlankSpace
          </span>
        </Link>

        <nav
          aria-label="PlankSpace"
          className="plankspace-desktop-links flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pr-6 [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {LINKS.map((link) => {
            const isActive = active(pathname, link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                className={`${pill} ${isActive ? current : idle}`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="plankspace-desktop-actions ml-auto flex shrink-0 items-center gap-1">
          <AdminNavLink className={`${pill} ${idle}`} />
          <Link
            href="/profile-editor"
            aria-current={onEditor ? "page" : undefined}
            className={`${pill} ${
              onEditor
                ? current
                : "border-line-strong bg-wood-900 text-gold-300 hover:bg-wood-800"
            }`}
          >
            Edit Profile
          </Link>
          <Link
            href={profileHandle ? `/u/${profileHandle}` : "/profile-editor"}
            aria-current={profileHandle && pathname === `/u/${profileHandle}` ? "page" : undefined}
            className={`${pill} border-line-strong bg-gold-500 text-wood-950 hover:bg-gold-400`}
          >
            My Profile
          </Link>
        </div>
        <div className="plankspace-mobile-menu" ref={menu}>
          <button
            ref={menuTrigger}
            type="button"
            className={pill}
            aria-expanded={menuOpen}
            aria-controls="plankspace-mobile-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            Board menu
          </button>
          {menuOpen && (
            <nav id="plankspace-mobile-menu" aria-label="PlankSpace Board menu">
              {LINKS.map((link) => (
                <Link key={link.href} href={link.href} aria-current={active(pathname, link.href) ? "page" : undefined}>
                  {link.label}
                </Link>
              ))}
              <Link href="/profile-editor">Edit Profile</Link>
              <Link href={profileHandle ? `/u/${profileHandle}` : "/profile-editor"}>My Profile</Link>
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}

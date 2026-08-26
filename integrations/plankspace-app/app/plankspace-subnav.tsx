"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/plankspace", label: "Lumberyard" },
  { href: "/browse", label: "Browse" },
  { href: "/planks-list", label: "Planks" },
  { href: "/search", label: "Search" },
  { href: "/woodstock", label: "Woodstock" },
  { href: "/board-mail", label: "Board Mail" },
  { href: "/profile-editor", label: "My Space" },
] as const;

function active(pathname: string, href: string) {
  if (href === "/plankspace") return pathname === "/plankspace";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function PlankSpaceSubnav() {
  const pathname = usePathname() || "/plankspace";

  return (
    <div
      className="sticky top-[58px] z-[55] border-b border-amber-700/40 bg-[#24150d]/95 shadow-[0_8px_28px_rgba(0,0,0,.28)] backdrop-blur-md lg:top-[68px]"
      data-plankspace-subnav
    >
      <div className="mx-auto flex max-w-[1360px] items-center gap-2 overflow-x-auto px-3 py-2 sm:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="mr-1 flex shrink-0 items-center gap-2 pr-2">
          <span
            aria-hidden="true"
            className="grid h-7 w-7 place-items-center rounded-md border border-amber-500/35 bg-black/25 text-sm shadow-inner"
          >
            🪵
          </span>
          <span className="hidden text-xs font-black uppercase tracking-[0.16em] text-amber-200 sm:inline">
            PlankSpace
          </span>
        </div>

        <nav aria-label="PlankSpace" className="flex min-w-max items-center gap-1.5">
          {LINKS.map((link) => {
            const isActive = active(pathname, link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "inline-flex min-h-9 items-center rounded-md border px-3 py-1.5 text-xs font-extrabold uppercase tracking-wide transition",
                  isActive
                    ? "border-amber-400/60 bg-amber-400/15 text-amber-200 shadow-[inset_0_0_18px_rgba(245,158,11,.08)]"
                    : "border-transparent text-amber-100/70 hover:border-amber-500/30 hover:bg-amber-500/10 hover:text-amber-100",
                ].join(" ")}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { sanitizeBanner, type BannerDoc } from "@/lib/content-docs";

/**
 * Site-wide announcement bar, admin-managed at /admin → Content. Renders
 * nothing unless an enabled banner is stored, so the default page is
 * untouched. Dismissal is per-message per-session (sessionStorage keyed by
 * the banner text) — a changed announcement reappears once.
 */
const DISMISS_KEY = "plank-banner-dismissed-v1";

export default function SiteBanner() {
  const [banner, setBanner] = useState<BannerDoc | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/content/banner", {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { doc?: unknown };
        const parsed = sanitizeBanner(data.doc);
        if (!parsed.ok || !parsed.value.enabled) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setBanner(parsed.value);
        setDismissed(
          window.sessionStorage.getItem(DISMISS_KEY) === parsed.value.text
        );
      } catch {
        // No banner offline.
      }
    })();
    return () => controller.abort();
  }, []);

  if (!banner || dismissed) return null;

  const isInternal = banner.href.startsWith("/");

  return (
    <div
      data-market-shell
      role="status"
      className="relative z-[55] border-b border-gold-500/40 bg-gold-500 px-4 py-2 text-center text-sm font-bold text-[#261105]"
    >
      <span>{banner.text}</span>
      {banner.href ? (
        isInternal ? (
          <Link href={banner.href} className="ml-2 underline underline-offset-2">
            Learn more
          </Link>
        ) : (
          <a
            href={banner.href}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-2 underline underline-offset-2"
          >
            Learn more ↗
          </a>
        )
      ) : null}
      <button
        type="button"
        aria-label="Dismiss announcement"
        onClick={() => {
          window.sessionStorage.setItem(DISMISS_KEY, banner.text);
          setDismissed(true);
        }}
        className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md hover:bg-black/10"
      >
        ✕
      </button>
    </div>
  );
}

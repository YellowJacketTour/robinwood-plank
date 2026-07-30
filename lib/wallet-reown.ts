/**
 * Reown AppKit integration — Phase 1, flag-gated (NEXT_PUBLIC_WALLET_UI=reown).
 *
 * See docs/WALLET_REOWN_EVALUATION.md for the full evaluation and phasing.
 * This file holds only config/shared logic with no React and no top-level
 * import of @reown/appkit* — every AppKit package is pulled in lazily by
 * components/ConnectWalletModalReown.tsx (dynamically imported by callers),
 * so nothing here loads unless a consumer actually mounts that surface.
 *
 * Scope discipline: AppKit only ever supplies connect / session / provider
 * acquisition. Every send, simulate, gas-floor, and destination-allowlist
 * check still lives in lib/wallet.ts untouched. AppKit's own send/swap/
 * onramp/email/social UI is disabled via REOWN_FEATURES below.
 */

const LOCAL_STORAGE_OVERRIDE_KEY = "plank-wallet-ui";

/**
 * Default OFF. With the flag unset/off, nothing in this module or its
 * dynamic imports ever runs — the legacy WalletConnect QR path
 * (lib/wallet-connect.ts + ConnectWalletModal.tsx) is untouched.
 *
 * A localStorage override (mirroring the existing `plank-wc-project-id`
 * pattern in lib/wallet-connect.ts) lets this be flipped per-browser
 * without an env var change / dev server restart — useful for dogfooding
 * and for QA of this phase without redeploying.
 */
export function isReownWalletUIEnabled(): boolean {
  if (typeof window !== "undefined") {
    const override = window.localStorage
      .getItem(LOCAL_STORAGE_OVERRIDE_KEY)
      ?.trim()
      .toLowerCase();
    if (override === "reown") return true;
    if (override === "legacy") return false;
  }
  return (process.env.NEXT_PUBLIC_WALLET_UI || "").trim().toLowerCase() === "reown";
}

export function setReownWalletUIOverride(value: "reown" | "legacy" | null): void {
  if (typeof window === "undefined") return;
  if (value) window.localStorage.setItem(LOCAL_STORAGE_OVERRIDE_KEY, value);
  else window.localStorage.removeItem(LOCAL_STORAGE_OVERRIDE_KEY);
}

/**
 * Reown Cloud and WalletConnect Cloud are the same project/credential
 * system (confirmed in the evaluation doc) — reuse the existing env var,
 * do not provision a second project ID.
 */
export function getReownProjectId(): string {
  return (process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "").trim();
}

/**
 * Robinhood Chain (4663) restated as an AppKit custom network. CHAIN in
 * lib/constants.ts is the single source of truth; every field passed to
 * `defineChain()` in components/ConnectWalletModalReown.tsx is a mechanical
 * translation of it, not a restated value. (The actual defineChain() call
 * lives there, not here, so this config-only module never statically
 * imports @reown/appkit/* — keeping it safe for
 * ConnectWalletModalSwitch.tsx and any preview/consumer to import with the
 * flag off, without pulling AppKit into their bundle.)
 */

/**
 * RobinWood theme (DESIGN.md) mapped onto AppKit's documented theming
 * knobs (--apkt-accent, --apkt-color-mix[-strength], --apkt-font-family,
 * --apkt-border-radius-master — verified against the installed
 * @reown/appkit-ui ThemeHelperUtil, which has no other officially exposed
 * per-token override). AppKit does not expose a full per-token color API,
 * so accent + a wood-toned color-mix is the supported way to pull the
 * whole modal toward our palette instead of shipping AppKit's default
 * light-blue look unstyled next to our UI.
 */
export const REOWN_THEME_MODE = "dark" as const;
export const REOWN_THEME_VARIABLES = {
  "--apkt-accent": "#E9B43F", // gold-500
  "--apkt-color-mix": "#1B120A", // wood-950
  // 30% read as barely-there next to AppKit's own default dark theme in
  // screenshots — 55% is the lowest value that reliably reads as "our
  // palette" rather than "default AppKit, slightly tinted" at a glance,
  // verified against reown-verify-reown.png.
  "--apkt-color-mix-strength": 55,
  "--apkt-border-radius-master": "9px", // rounded.md
  "--apkt-font-family": "'Nunito Sans', sans-serif", // typography.body
} as const;

/**
 * Only injected + WalletConnect connectors. Every embedded-wallet / email /
 * social / SIWE / swap / onramp / send-transaction feature is explicitly
 * disabled — out of scope per the adoption decision, and AppKit's own
 * "send" UI must never substitute for lib/wallet.ts's sendTransaction().
 */
export const REOWN_FEATURES = {
  analytics: false,
  email: false,
  socials: false,
  swaps: false,
  onramp: false,
  send: false,
  receive: false,
  history: false,
  legalCheckbox: false,
  connectMethodsOrder: ["wallet"] as const,
} as const;

export const REOWN_METADATA = {
  name: "plank.love",
  description: "RobinWood Marketplank — Instant Swap & vault",
  icons: ["https://plank.love/plank-social.jpg"],
} as const;

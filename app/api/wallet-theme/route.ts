import { getWalletTheme, saveWalletTheme } from "@/lib/wallet-theme-store";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Per-wallet color theme, synced across devices/browsers -- see migration
 * 013_wallet_theme_prefs.sql's own header for the full reasoning. GET is
 * read-only (called on every wallet connect/account-switch by
 * ThemeAccentPicker.tsx); POST writes the caller's current pick.
 *
 * NO wallet proof, same reasoning as POST /api/referral/code: this is a
 * cosmetic, non-custodial, non-identity-asserting preference. Writing a
 * theme against an address you don't control changes nothing but that
 * wallet's next-connect accent color -- correctable in one click by its
 * real owner, not a security property worth gating behind a signature.
 */
export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "wallet-theme-get", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    const { searchParams } = new URL(req.url);
    const wallet = (searchParams.get("wallet") ?? "").trim();
    if (!HEX_ADDRESS.test(wallet)) {
      return publicJson({ error: "BAD_WALLET_ADDRESS", message: "Valid wallet address required." }, 400);
    }

    const theme = await getWalletTheme(wallet);
    return publicJson({ theme });
  } catch (err) {
    return publicError(err, "Could not load this wallet's theme.");
  }
}

type Body = { wallet?: unknown; theme?: unknown };

export async function POST(req: Request) {
  try {
    // Tighter than the read limit: nothing legitimate writes this more than
    // a handful of times per minute even during active picker use.
    const limited = rateLimit(req, { key: "wallet-theme-post", limit: 20, windowMs: 60_000 });
    if (limited) return limited;

    const body = await readJsonBody<Body>(req);
    const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
    if (!HEX_ADDRESS.test(wallet)) {
      return publicJson({ error: "BAD_WALLET_ADDRESS", message: "Valid wallet address required." }, 400);
    }
    if (typeof body.theme !== "object" || body.theme === null) {
      return publicJson({ error: "BAD_THEME", message: "A theme object is required." }, 400);
    }

    const result = await saveWalletTheme(wallet, body.theme as Record<string, unknown>);
    if (!result.ok) {
      return publicJson({ error: result.error, message: "Invalid wallet or theme values." }, 400);
    }
    return publicJson({ ok: true });
  } catch (err) {
    return publicError(err, "Could not save this wallet's theme.");
  }
}

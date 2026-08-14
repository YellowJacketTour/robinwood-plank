import crypto from "node:crypto";
import { TradeApiError } from "@/lib/uniswap-server";

/**
 * MoonPay on-ramp / off-ramp integration. Mirrors the security posture of
 * lib/zerox-server.ts and lib/uniswap-server.ts exactly: server-only secret
 * key, hard off-by-default flag, no client-controlled fee or destination
 * override, real signed-URL scheme (not a guess) confirmed against
 * dev.moonpay.com/docs/off-ramp-enhance-security-using-signed-urls:
 *   base64(HMAC-SHA256(secretKey, "?" + queryString))
 * appended as the widget URL's final `signature` query param. The widget
 * itself (MoonPay's hosted checkout) handles the actual fiat/KYC/payout —
 * this module only ever builds a signed entry URL and never touches funds
 * or holds a fund-moving key, same non-custodial boundary as every other
 * integration in this app.
 *
 * ASSET: currencyCode defaults to "usdg" -- CONFIRMED (not guessed) that
 * MoonPay delivers USDG directly onto Robinhood Chain in production
 * (moonpay.com/newsroom/moonpay-robinhoodchain, MoonPay's own announcement).
 * This is a DIFFERENT asset than the ETH/$PLANK pair SwapWidget trades --
 * MoonPay lands real USDG in the connected wallet; converting that to
 * $PLANK is a second, separate step through the existing swap UI. That step
 * needs no import: USDG is already pinned in lib/uniswap-tokenlist.ts's
 * core counter tokens and shows up as a routing hop in live quotes, so it
 * is in the swap selector the moment the buyer returns. Not a guessed
 * one-step "buy $PLANK with a card" flow, because no such direct MoonPay
 * pair is confirmed to exist.
 *
 * ORDER TRACKING lives in lib/moonpay-orders.ts + app/api/moonpay/webhook:
 * every URL built here carries an externalCustomerId that MoonPay echoes
 * back on its signed order webhook, which is the only way we learn what
 * became of a checkout after the buyer leaves. That is also our only
 * visibility into our merchant key being used to drive volume we did not
 * originate.
 */

/**
 * HARD OFF, pending a working kill switch. Not env-controlled on purpose.
 *
 * NEXT_PUBLIC_* is inlined into the SERVER bundle at build time whenever the
 * build environment defines it -- measured on this toolchain, not inferred.
 * This module is server-side, and the deploy workflow already puts
 * NEXT_PUBLIC_MOONPAY_ENABLED in the build env, so on merge this flag would
 * have been frozen into the release as a literal with no runtime path left.
 * Turning the ramp off afterwards would have required a rebuild, and the
 * repository variable would have looked like a switch while controlling
 * nothing.
 *
 * That is exactly what happened to referrals: the variable was set to false,
 * a deploy ran green, the running server kept reporting enabled, and the
 * feature had to be disabled in source. This one is being disarmed BEFORE it
 * ships rather than after.
 *
 * The variable was also already set to `true` on the repository while this
 * branch was unmerged, so merging would have shipped the ramp live.
 *
 * TO RE-ENABLE: not by restoring this line. Move the flag to a DB-resolved
 * kill switch on a name WITHOUT the NEXT_PUBLIC_ prefix (see
 * app/api/trade/status/route.ts, which ORs a database override over the baked
 * value so a pause lands without a deploy), and prove the switch works on a
 * throwaway flag first. test/market/server-feature-flags.test.ts on `dev`
 * fails if this returns in the old shape.
 */
export const MOONPAY_ENABLED = false;

const DEFAULT_CURRENCY_CODE = "usdg";

/**
 * Currency codes this integration will sign a URL for. `currencyCode` is
 * client-supplied, and while URLSearchParams makes param injection
 * impossible, an unbounded value means we HMAC a checkout for any string a
 * caller invents -- a typo then fails deep inside MoonPay's hosted flow
 * instead of at our edge, with our signature on it. USDG is the only asset
 * MoonPay confirms delivering onto Robinhood Chain today; extend this list
 * when that changes, not the callers.
 */
const SUPPORTED_CURRENCY_CODES = new Set(["usdg"]);

function assertSupportedCurrency(code: string): void {
  if (!SUPPORTED_CURRENCY_CODES.has(code.trim().toLowerCase())) {
    throw new TradeApiError(
      400,
      "UNSUPPORTED_CURRENCY",
      "That currency is not supported by this ramp."
    );
  }
}

function requireSecrets(): { apiKey: string; secretKey: string } {
  const apiKey = process.env.MOONPAY_API_KEY;
  const secretKey = process.env.MOONPAY_SECRET_KEY;
  if (!apiKey || !secretKey) {
    throw new TradeApiError(
      503,
      "MOONPAY_NOT_CONFIGURED",
      "MoonPay is not configured on the server."
    );
  }
  return { apiKey, secretKey };
}

export function isMoonPayConfigured(): boolean {
  return Boolean(process.env.MOONPAY_API_KEY && process.env.MOONPAY_SECRET_KEY);
}

export function moonpayEnv(): "sandbox" | "production" {
  return process.env.MOONPAY_ENV === "production" ? "production" : "sandbox";
}

function buyBaseUrl(): string {
  return moonpayEnv() === "production" ? "https://buy.moonpay.com" : "https://buy-sandbox.moonpay.com";
}

function sellBaseUrl(): string {
  return moonpayEnv() === "production" ? "https://sell.moonpay.com" : "https://sell-sandbox.moonpay.com";
}

function sign(secretKey: string, queryString: string): string {
  return crypto.createHmac("sha256", secretKey).update(queryString).digest("base64");
}

function isEthAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Real buy (on-ramp) widget URL.
 *
 * ON THE DESTINATION ADDRESS, deliberately: `walletAddress` is whatever the
 * caller sends, and the server does NOT prove the caller controls it. That
 * is not an oversight, so don't "fix" it with a wallet-proof signature:
 *
 *  - There is no integrity property to protect. The destination is the
 *    buyer's own wallet, and the buyer is the one paying. Sending someone
 *    else's address here means paying for crypto that lands in their wallet
 *    -- a gift, not an attack.
 *  - A signature would not stop the abuse people reach for this to stop.
 *    Anyone building a URL to a wallet THEY control can sign for it
 *    perfectly well, and a signed URL is a bearer token the moment it
 *    exists.
 *  - It would cost real UX: a personal_sign prompt in front of a
 *    card purchase, which reads as "why is this asking me to sign
 *    something to spend money?" -- the single worst place in the app to
 *    add a wallet interaction.
 *
 * The exposure that IS real -- someone driving volume through URLs signed
 * with our merchant key, so fraud/chargebacks land against our MoonPay
 * account -- is a merchant-account problem, addressed with MoonPay's own
 * fraud tooling plus the order-tracking webhook noted in the module header,
 * not with a signature at this layer.
 */
export function buildBuyWidgetUrl(walletAddress: string, currencyCode = DEFAULT_CURRENCY_CODE): { url: string; sandbox: boolean } {
  if (!isEthAddress(walletAddress)) {
    throw new TradeApiError(400, "BAD_WALLET_ADDRESS", "walletAddress must be a valid 0x address.");
  }
  assertSupportedCurrency(currencyCode);
  const { apiKey, secretKey } = requireSecrets();

  const params = new URLSearchParams({
    apiKey,
    currencyCode,
    walletAddress,
    // Round-trips through the order webhook (app/api/moonpay/webhook), which
    // is the only way we learn an order's outcome. The destination wallet
    // itself is used as the id rather than a freshly minted opaque one: it
    // needs no extra pre-checkout write to map back, and it discloses
    // nothing new, since walletAddress is already in this same URL.
    externalCustomerId: walletAddress.toLowerCase(),
  });
  const queryString = `?${params.toString()}`;
  const signature = sign(secretKey, queryString);

  return {
    url: `${buyBaseUrl()}/${queryString}&signature=${encodeURIComponent(signature)}`,
    sandbox: moonpayEnv() !== "production",
  };
}

/**
 * Real sell (off-ramp) widget URL -- confirmed via
 * dev.moonpay.com/docs/ramps-sdk-sell-params: separate host
 * (sell.moonpay.com / sell-sandbox.moonpay.com), same signed-URL scheme,
 * real param names (baseCurrencyCode, refundWalletAddress). The widget
 * shows the user a MoonPay deposit address and guides the crypto-out +
 * fiat-payout flow -- this function only ever builds the signed entry URL.
 */
export function buildSellWidgetUrl(
  refundWalletAddress: string,
  baseCurrencyCode = DEFAULT_CURRENCY_CODE,
  baseCurrencyAmount?: string
): { url: string; sandbox: boolean } {
  if (!isEthAddress(refundWalletAddress)) {
    throw new TradeApiError(400, "BAD_WALLET_ADDRESS", "refundWalletAddress must be a valid 0x address.");
  }
  assertSupportedCurrency(baseCurrencyCode);
  const { apiKey, secretKey } = requireSecrets();

  const params = new URLSearchParams({
    apiKey,
    baseCurrencyCode,
    refundWalletAddress,
    externalCustomerId: refundWalletAddress.toLowerCase(),
  });
  // Optional pre-fill (MoonPayPanel.tsx sends the real, just-read USDG
  // balance). Validated as a plain positive decimal -- never trust a
  // client-supplied string straight into a signed URL without checking its
  // shape first.
  if (baseCurrencyAmount !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(baseCurrencyAmount) || Number(baseCurrencyAmount) <= 0) {
      throw new TradeApiError(400, "BAD_AMOUNT", "baseCurrencyAmount must be a positive decimal number.");
    }
    params.set("baseCurrencyAmount", baseCurrencyAmount);
  }
  const queryString = `?${params.toString()}`;
  const signature = sign(secretKey, queryString);

  return {
    url: `${sellBaseUrl()}/${queryString}&signature=${encodeURIComponent(signature)}`,
    sandbox: moonpayEnv() !== "production",
  };
}

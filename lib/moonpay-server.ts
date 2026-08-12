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
 * $PLANK is a second, separate step through the existing swap UI (import
 * USDG by address, same "any ERC-20 by address" path SwapWidget already
 * supports). Not a guessed one-step "buy $PLANK with a card" flow, because
 * no such direct MoonPay pair is confirmed to exist.
 */

export const MOONPAY_ENABLED =
  process.env.NEXT_PUBLIC_MOONPAY_ENABLED?.trim().toLowerCase() === "true";

const DEFAULT_CURRENCY_CODE = "usdg";

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
 * Real buy (on-ramp) widget URL. walletAddress must be the CALLER'S OWN
 * connected wallet -- this route never accepts a destination on behalf of
 * someone else, same non-custodial boundary as every trade route in this
 * app. externalCustomerId round-trips through MoonPay's webhook (once
 * configured) so a future order-status feature can key back to a session
 * without trusting anything client-supplied at that point.
 */
export function buildBuyWidgetUrl(walletAddress: string, currencyCode = DEFAULT_CURRENCY_CODE): { url: string; sandbox: boolean } {
  if (!isEthAddress(walletAddress)) {
    throw new TradeApiError(400, "BAD_WALLET_ADDRESS", "walletAddress must be a valid 0x address.");
  }
  const { apiKey, secretKey } = requireSecrets();

  const params = new URLSearchParams({
    apiKey,
    currencyCode,
    walletAddress,
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
  const { apiKey, secretKey } = requireSecrets();

  const params = new URLSearchParams({
    apiKey,
    baseCurrencyCode,
    refundWalletAddress,
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

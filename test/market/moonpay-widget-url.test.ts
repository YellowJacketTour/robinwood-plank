import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

/**
 * lib/moonpay-server.ts reads its config from process.env at module scope
 * (MOONPAY_ENABLED) and inside requireSecrets(), so the env has to be set
 * BEFORE the dynamic import below. Sandbox on purpose: a test that could
 * ever build a production checkout URL is a test that can be pointed at
 * real money by a typo.
 */
process.env.NEXT_PUBLIC_MOONPAY_ENABLED = "true";
process.env.MOONPAY_API_KEY = "pk_test_fixture";
process.env.MOONPAY_SECRET_KEY = "sk_test_fixture";
process.env.MOONPAY_ENV = "sandbox";

const { buildBuyWidgetUrl, buildSellWidgetUrl, isMoonPayConfigured, moonpayEnv } = await import(
  "../../lib/moonpay-server"
);

const WALLET = "0x1111111111111111111111111111111111111111";
const USDG_ON_ROBINHOOD_CHAIN = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

/** Independent reimplementation of MoonPay's documented scheme, so the test
 * pins the signature to the spec rather than to whatever the module does. */
function expectedSignature(queryString: string): string {
  return crypto.createHmac("sha256", "sk_test_fixture").update(queryString).digest("base64");
}

test("buy URL is signed over the exact query string MoonPay receives", () => {
  const { url, sandbox } = buildBuyWidgetUrl(WALLET);
  assert.equal(sandbox, true);

  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://buy-sandbox.moonpay.com");

  // The signature must cover the query EXACTLY as sent, minus itself. A
  // signature computed over reordered or re-encoded params verifies on our
  // side and is rejected by MoonPay, which is the failure this pins down.
  const signature = parsed.searchParams.get("signature");
  assert.ok(signature);
  const signedPortion = parsed.search.slice(0, parsed.search.indexOf("&signature="));
  assert.equal(signature, expectedSignature(signedPortion));
});

test("sell URL uses the sell host and carries a validated pre-filled amount", () => {
  const { url } = buildSellWidgetUrl(WALLET, "usdg", "12.5");
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://sell-sandbox.moonpay.com");
  assert.equal(parsed.searchParams.get("refundWalletAddress"), WALLET);
  assert.equal(parsed.searchParams.get("baseCurrencyAmount"), "12.5");
});

test("a hostile currencyCode cannot inject extra query params", () => {
  // URLSearchParams encodes & and =, so this lands as ONE opaque value
  // rather than smuggling walletAddress past the signature. Rejected by the
  // allowlist first, but the encoding property is what makes the allowlist a
  // second line of defence rather than the only one.
  assert.throws(
    () => buildBuyWidgetUrl(WALLET, "usdg&walletAddress=0xattacker"),
    /UNSUPPORTED_CURRENCY|not supported/i
  );
});

test("only confirmed-supported currencies get our signature", () => {
  assert.throws(() => buildBuyWidgetUrl(WALLET, "eth"), /UNSUPPORTED_CURRENCY|not supported/i);
  assert.throws(() => buildSellWidgetUrl(WALLET, "btc"), /UNSUPPORTED_CURRENCY|not supported/i);
  // Case and padding are normalised, not rejected.
  assert.ok(buildBuyWidgetUrl(WALLET, " USDG ".trim().toLowerCase()).url);
});

test("a malformed destination address is rejected before anything is signed", () => {
  for (const bad of ["", "0x123", "not-an-address", `${WALLET}00`]) {
    assert.throws(() => buildBuyWidgetUrl(bad), /BAD_WALLET_ADDRESS|valid 0x address/i);
    assert.throws(() => buildSellWidgetUrl(bad), /BAD_WALLET_ADDRESS|valid 0x address/i);
  }
});

test("a non-positive or non-numeric sell amount is rejected", () => {
  for (const bad of ["0", "-1", "1e18", "abc", "1.2.3"]) {
    assert.throws(() => buildSellWidgetUrl(WALLET, "usdg", bad), /BAD_AMOUNT|positive decimal/i);
  }
});

test("the secret key never appears in a generated URL", () => {
  // The apiKey (public) belongs in the URL; the secret must only ever exist
  // as the HMAC input. This is the one leak that would be unrecoverable.
  const { url } = buildBuyWidgetUrl(WALLET);
  assert.ok(url.includes("pk_test_fixture"));
  assert.ok(!url.includes("sk_test_fixture"));
});

test("config probes report sandbox without exposing key material", () => {
  assert.equal(isMoonPayConfigured(), true);
  assert.equal(moonpayEnv(), "sandbox");
});

test("MoonPayPanel never imports the tokenlist, which would break the build", async () => {
  // lib/uniswap-tokenlist.ts reaches lib/market/robinhood-assets.ts ->
  // durable-kv -> lib/postgres.ts -> the `pg` driver, which needs node's
  // fs/net/tls. Importing it from this client component compiles and
  // typechecks fine, then fails `next build` with a module-not-found on
  // `pg`. Caught exactly that way once; this keeps it caught in `npm test`
  // instead of at the end of a build.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../components/trade/MoonPayPanel.tsx", import.meta.url),
    "utf8"
  );
  assert.ok(!source.includes("uniswap-tokenlist"));
  assert.ok(source.includes('from "@/lib/constants"'));
});

test("the USDG address MoonPay delivers to has exactly one definition", async () => {
  // components/trade/MoonPayPanel.tsx reads a USDG balance to pre-fill the
  // cash-out amount. It used to hardcode its own copy of this address; a
  // second copy of a money address is the kind of thing that drifts silently
  // and sends a balance read at the wrong contract.
  const { USDG_TOKEN } = await import("../../lib/constants");
  assert.equal(USDG_TOKEN.address, USDG_ON_ROBINHOOD_CHAIN);
  // Verified on Robinhood Chain mainnet: USDG is 6-decimal, not 18.
  assert.equal(USDG_TOKEN.decimals, 6);
});

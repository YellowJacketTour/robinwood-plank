import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isEvmAddress } from "@/lib/market/multichain/resolve-contract-address";

/**
 * "It isn't hydrating anything no matter how long I visit or refresh."
 *
 * Reported live on Milady Maker, and reproduced exactly:
 *
 *   /hydrate-token?collectionSlug=milady   -> {"resolved": false}
 *   /hydrate-token?collectionSlug=0x5af0…  -> full metadata, image, traits
 *
 * Same token, same route, same archive. Nothing was missing upstream. Several
 * routes gated real work behind `/^0x…{40}$/.test(collectionSlug)`, so a
 * collection addressed by NAME -- which is how the app links to it -- silently
 * did nothing. The failure is DETERMINISTIC, which is why waiting and
 * refreshing could never fix it.
 *
 * A shape test is not an identity test.
 */

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const HYDRATE = read("app/api/market/multichain/hydrate-token/route.ts");
const TOKENS = read("app/api/market/multichain/tokens/route.ts");
const FOCUS = read("lib/market/multichain/edge/predictive-focus.ts");

test("isEvmAddress still recognises a real address, and rejects a name", () => {
  assert.ok(isEvmAddress("0x5af0d9827e0c53e4799bb226655a1de152a425a5"));
  assert.ok(!isEvmAddress("milady"));
  assert.ok(!isEvmAddress(null));
  assert.ok(!isEvmAddress("0x5af0"), "a truncated address is not an address");
});

test("hydrate-token excludes Bitcoin by CHAIN, not by string shape", () => {
  // The original 0x guard existed to keep Bitcoin ordinal ids out of scope --
  // a real goal, implemented with a test that also caught every named EVM
  // collection. Bitcoin must still be excluded, by what it IS.
  assert.match(FOCUS + HYDRATE, /isBitcoinChainSlug/, "Bitcoin exclusion must survive");
  assert.ok(
    !/if \(!\/\^0x\[0-9a-fA-F\]\{40\}\$\/\.test\(collectionSlug\)\) \{\s*\n\s*\/\/ Bitcoin/.test(HYDRATE),
    "hydrate-token must not gate on the slug's shape",
  );
});

test("the three hydration paths resolve the address instead of demanding one", () => {
  for (const [name, src] of [["hydrate-token", HYDRATE], ["tokens", TOKENS], ["predictive-focus", FOCUS]] as const) {
    assert.match(src, /resolveEvmContractAddress/, `${name} must resolve, not shape-test`);
  }
});

test("focusTokens passes the RESOLVED address downstream, not the raw slug", () => {
  // Resolving and then still passing the slug to the hydrator would fail in
  // exactly the same way, one layer deeper -- the fix would look applied and
  // change nothing.
  assert.match(
    FOCUS,
    /hydrateSpecificToken\(chainSlug, contractAddress, tokenId\)/,
    "the hydrator must receive the resolved contract address",
  );
  assert.match(
    FOCUS,
    /pendingTokenIds\(chainSlug, contractAddress, ids\)/,
    "the pending lookup must also use the resolved address",
  );
});

test("the demand enqueue is not shape-gated", () => {
  // This is the signal that says "a visitor is looking at this collection
  // NOW". Gated on shape, a page opened by name recorded no demand at all --
  // so visiting genuinely could not cause hydration.
  assert.ok(
    !/const contractAddress = \/\^0x\[0-9a-fA-F\]\{40\}\$\/\.test\(collectionSlug\) \? collectionSlug\.toLowerCase\(\) : null;/.test(TOKENS),
    "the demand enqueue must resolve the address",
  );
});

test("no hydration path anywhere still gates real work on the slug's shape", () => {
  // Tree-wide, because the first pass at this fixed the files I had already
  // opened and missed three others.
  let hits = "";
  try {
    hits = execFileSync(
      "git",
      ["grep", "-n", "test(collectionSlug) ? collectionSlug : null", "--", "app", "lib"],
      { encoding: "utf8" },
    ).trim();
  } catch (e) {
    if ((e as { status?: number }).status !== 1) throw e;
  }
  assert.equal(hits, "", `these still shape-gate instead of resolving:\n${hits}`);
});

/**
 * The resolver itself.
 *
 * My FIRST version of resolveEvmContractAddress used only
 * getTrackedCollection, which queries `WHERE contract_address = $2` -- so
 * passing a slug matched nothing and the function was a no-op for exactly the
 * case it was written for. Every route above would have kept doing nothing
 * while looking fixed. These assertions pin the ordering that makes it real.
 */
const RESOLVER = read("lib/market/multichain/resolve-contract-address.ts");

test("an address passes through untouched, without a lookup", () => {
  // The common case must not cost a DB round-trip or an OpenSea call.
  const at = RESOLVER.indexOf("export async function resolveEvmContractAddress");
  const body = RESOLVER.slice(at);
  const passThrough = body.indexOf("if (EVM_ADDRESS.test(collectionSlug)) return collectionSlug;");
  const firstLookup = body.indexOf("getTrackedCollection");
  assert.ok(passThrough > 0, "an address must short-circuit");
  assert.ok(passThrough < firstLookup, "and must do so BEFORE any lookup");
});

test("the resolver does not rely on the DB alone", () => {
  // getTrackedCollection matches on contract_address, so a slug finds nothing.
  // Without the OpenSea fallback this function cannot resolve a name at all.
  assert.match(
    RESOLVER,
    /openSeaCollectionContract/,
    "a slug must resolve via OpenSea's collection metadata, not only the archive",
  );
});

test("a failed resolve is remembered only briefly", () => {
  // Caching a negative forever is a real bug this codebase already hit: one
  // transient OpenSea failure poisoned a collection for the process lifetime.
  assert.match(RESOLVER, /NEGATIVE_TTL_MS/, "failures need an expiring window");
  const m = RESOLVER.match(/NEGATIVE_TTL_MS = ([0-9_]+)/);
  assert.ok(m, "the window must be declared");
  const ms = Number(m[1].replace(/_/g, ""));
  assert.ok(ms > 0 && ms <= 5 * 60_000, `a negative window must expire promptly (saw ${ms}ms)`);
});

test("a successful resolve is cached, so the fix is not a per-request tax", () => {
  assert.match(RESOLVER, /addressCache\.set/, "successes must be cached");
});

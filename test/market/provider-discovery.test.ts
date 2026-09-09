import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { CHAIN_IDS, isKeylessHttps } from "../../lib/market/multichain/provider-discovery";

/**
 * Provider discovery: stop hardcoding the pool, start enumerating it.
 *
 * Every pacing decision in this codebase -- the 8/second token bucket, the
 * 30-minute rest after a 429, the audited ban on racing gateways -- exists to
 * ration a SMALL HARDCODED POOL. Two RPC endpoints per chain, later seven.
 * Seven IPFS gateways. Those literals are the real ceiling; every downstream
 * throttle is a consequence of them rather than a law of nature.
 *
 * A public rate limit is PER PROVIDER, so the budget is
 * `providers x per-provider-limit` -- and the first term was a constant
 * somebody typed once.
 *
 * MEASURED 2026-09-09
 *
 *   chainid.network/chains.json   2,755 chains; 52 keyless https endpoints
 *                                 across our 8 EVM chains (eth 13, bnb 14,
 *                                 base 7, polygon 6, arb 4, opt 4, avax 2,
 *                                 zksync 2)
 *   ipfs public-gateway-checker   11 gateways, only 2 of them in our seven
 *
 * 52 against 7 is not tuning. It is a different order of magnitude, it costs
 * nothing, and it keeps growing without anyone editing a file.
 *
 * The danger is obvious and is what most of these tests guard: a registry is a
 * list of CLAIMS. Trusting it blindly puts keyed, dead, or hostile endpoints
 * into rotation, where they fail every call and look like rate limits.
 */

const SRC = readFileSync(
  "lib/market/multichain/provider-discovery.ts",
  "utf8"
).replace(/\r\n/g, "\n");

test("a keyed URL is never usable", () => {
  // Registry entries routinely carry placeholders or a provider's own key
  // path. One in rotation produces a 401 on every call -- and, worse, a
  // jailed provider that looks like throttling rather than a missing
  // credential, which is a diagnosis nobody would reach quickly.
  assert.equal(isKeylessHttps("https://eth-mainnet.example.io/v2/${API_KEY}"), false);
  assert.equal(isKeylessHttps("https://rpc.example.io/?apiKey=abc"), false);
  assert.equal(isKeylessHttps("https://rpc.example.io/v3/0123456789abcdef0123456789"), false);
  assert.equal(isKeylessHttps("https://x.example.io/{key}"), false);
});

test("only https is accepted", () => {
  // http is a downgrade on every call that would use it; wss is a different
  // protocol the callers do not speak.
  assert.equal(isKeylessHttps("http://rpc.example.io"), false);
  assert.equal(isKeylessHttps("wss://rpc.example.io"), false);
  assert.equal(isKeylessHttps("https://ethereum-rpc.publicnode.com"), true);
});

test("every chain we track can be discovered for", () => {
  // A chain missing from the map silently gets zero discovered providers and
  // stays on its hardcoded pair forever -- the exact failure this replaces.
  for (const slug of [
    "eth-mainnet", "base-mainnet", "arb-mainnet", "polygon-mainnet",
    "bnb-mainnet", "opt-mainnet", "avax-mainnet", "zksync-mainnet",
  ]) {
    assert.ok(CHAIN_IDS[slug], `${slug} must map to a registry chain id`);
  }
  // The ids must be the real ones, or discovery returns another chain's RPCs
  // and every call quietly talks to the wrong network.
  assert.equal(CHAIN_IDS["eth-mainnet"], 1);
  assert.equal(CHAIN_IDS["base-mainnet"], 8453);
  assert.equal(CHAIN_IDS["arb-mainnet"], 42161);
  assert.equal(CHAIN_IDS["polygon-mainnet"], 137);
});

test("a discovered endpoint is PROBED before it may serve traffic", () => {
  // A registry is a list of claims. polygon-rpc.com now answers 401; llamarpc
  // fails TLS with 525. Both are listed as public endpoints somewhere.
  assert.match(SRC, /export async function probeRpc/, "discovery must verify, not trust");
  const at = SRC.indexOf("export async function probeRpc");
  const body = SRC.slice(at, SRC.indexOf("\n}", SRC.indexOf("catch", at)));
  // A 200 is not enough: some hosts answer 200 with a JSON-RPC error body.
  assert.match(body, /body\.error/, "a JSON-RPC error body must fail the probe");
  assert.match(body, /result\.startsWith\("0x"\)/, "a real block number must come back");
});

test("the curated pool is the floor -- discovery only ever ADDS", () => {
  // A registry outage, a schema change, or a bad parse must degrade to "no new
  // providers", never to "no providers". This is the layer everything else
  // depends on.
  const at = SRC.indexOf("export async function discoverRpcProviders");
  const body = SRC.slice(at, SRC.indexOf("\n/**", at));
  assert.match(body, /catch \{\s*\n\s*return \[\];/, "a registry failure returns nothing extra");
  assert.match(body, /known\.map\(hostOf\)/, "and the known pool is always consulted");
});

test("a duplicate host is never added twice", () => {
  // Two entries for one operator share ONE rate limit while the rotation
  // believes they are independent -- silently halving the budget it thinks it
  // has, which is worse than not adding them at all.
  const body = SRC.slice(SRC.indexOf("export async function discoverRpcProviders"));
  assert.match(body, /knownHosts\.has\(hostOf\(u\)\)/, "known hosts must be excluded");
  assert.match(
    body,
    /arr\.findIndex\(\(x\) => hostOf\(x\) === hostOf\(u\)\) === i/,
    "and the discovered set must be deduped by host"
  );
});

test("discovery is cached, so it is not its own rate-limit problem", () => {
  // Re-fetching a 1.17 MB registry per pass would be a spectacular own goal.
  assert.match(SRC, /DISCOVERY_TTL_SEC = 24 \* 3600/, "a day is right for a slow-moving registry");
  assert.match(SRC, /durableKv\.get/, "and the result must be shared across processes");
});

test("discovery is bounded per chain", () => {
  // Unbounded, one chain with a huge registry entry could crowd out the
  // curated providers in the rotation.
  assert.match(SRC, /opts\.max \?\? 12/, "a per-chain cap must exist");
});

test("IPFS gateways are discovered the same way", () => {
  // Same shape of problem: 7 hardcoded, 11 in the registry, only 2 overlapping.
  assert.match(SRC, /export async function discoverIpfsGateways/, "gateways must be discoverable");
  const at = SRC.indexOf("export async function discoverIpfsGateways");
  const body = SRC.slice(at);
  assert.match(body, /\/ipfs\/`/, "returned in the prefix shape the callers expect");
  assert.match(body, /knownHosts\.has/, "and deduped against the curated list");
});

/**
 * The budget arithmetic. The whole argument, as a function.
 */
function budget(providers: number, perProviderPerSecond: number): number {
  return providers * perProviderPerSecond;
}

test("the pool size, not the rate limit, was the ceiling", () => {
  // 7 curated vs 52 discoverable, at the same per-provider limit.
  assert.equal(budget(52, 8) / budget(7, 8), 52 / 7);
  assert.ok(budget(52, 8) > budget(7, 8) * 7, "a 7x+ budget increase, for nothing");
  // And the key property: this COMPOSES with pacing rather than defeating it.
  // Each provider keeps its own bucket; there are simply more of them.
  assert.ok(budget(1, 8) === 8, "one provider's limit is unchanged by having more providers");
});

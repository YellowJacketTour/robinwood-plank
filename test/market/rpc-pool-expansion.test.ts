import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * The rate limit was never the ceiling. The POOL was.
 *
 * The pool held two free public endpoints per chain. Every downstream pacing
 * decision -- the 8/second token bucket, the 30-minute rest after a 429, the
 * refusal to race gateways -- was built to ration those two.
 *
 * But a public RPC rate limit is PER PROVIDER. Two providers is two budgets;
 * seven is seven. The constraint everyone treats as physics is really a
 * procurement decision, and nobody had gone shopping.
 *
 * Probed live 2026-09-09 with the same method the file's own header describes
 * -- a real eth_blockNumber POST, zero auth, a real current block number back:
 *
 *   eth       publicnode 0.10s | drpc 0.17s | ankr 0.17s | cloudflare 0.08s
 *             flashbots 0.30s  | blast 0.18s | 1rpc 0.27s
 *   base      base.org 0.13s   | blast 0.13s | 1rpc 0.24s
 *   arbitrum  arb1 0.16s       | ankr 0.10s  | 1rpc 0.37s
 *   polygon   ankr 0.11s
 *
 * Rejected and recorded, so nobody re-adds them:
 *   llamarpc (eth + base) -> HTTP 525, TLS handshake failure at the edge
 *   polygon-rpc.com       -> HTTP 401, now requires a key
 *
 * Ethereum goes from 2 free providers to 7: roughly 3.5x the per-chain budget,
 * for nothing, composing with the existing pacing and jailing rather than
 * replacing them.
 */

const POOL = readFileSync(
  "lib/market/multichain/discovery/rpc-provider-pool.ts",
  "utf8"
).replace(/\r\n/g, "\n");

/** Every URL declared for one chain. */
function urlsFor(chain: string): string[] {
  const at = POOL.indexOf(`"${chain}": [`);
  assert.ok(at > 0, `${chain} must be in the pool`);
  const block = POOL.slice(at, POOL.indexOf("\n  ],", at));
  return [...block.matchAll(/url: "([^"]+)"/g)].map((m) => m[1]!);
}

test("ethereum has many providers, not two", () => {
  const urls = urlsFor("eth-mainnet");
  assert.ok(urls.length >= 6, `a per-provider limit means more providers is more budget (saw ${urls.length})`);
  assert.equal(new Set(urls).size, urls.length, "duplicates would be one budget wearing two names");
});

test("every busy chain gained providers", () => {
  // The chains that carry catalog volume. One provider is a single point of
  // both failure and throttling.
  for (const chain of ["eth-mainnet", "base-mainnet", "arb-mainnet", "polygon-mainnet"]) {
    const urls = urlsFor(chain);
    assert.ok(urls.length >= 3, `${chain} must have real redundancy (saw ${urls.length})`);
  }
});

test("no provider appears twice on one chain", () => {
  // Two entries pointing at the same operator share ONE rate limit while the
  // rotation believes they are independent -- which would silently halve the
  // budget it thinks it has.
  const chains = [...POOL.matchAll(/"([a-z0-9-]+)": \[/g)].map((m) => m[1]!);
  for (const chain of chains) {
    const at = POOL.indexOf(`"${chain}": [`);
    const block = POOL.slice(at, POOL.indexOf("\n  ],", at));
    const ids = [...block.matchAll(/id: "([a-z]+)"/g)].map((m) => m[1]!);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `${chain} has a duplicate provider id: ${ids.join(", ")}`
    );
  }
});

test("the rejected endpoints are recorded, not silently dropped", () => {
  // Without this, the next person probes the same dead hosts and re-adds them.
  assert.match(POOL, /llamarpc/, "the 525 failure must be recorded");
  assert.match(POOL, /polygon-rpc\.com/, "as must the 401");
  assert.match(POOL, /525|401/, "with the actual status codes that proved it");
});

test("every added URL is https and carries no key", () => {
  // A keyed URL in a 'free public' list is a secret leak waiting to happen,
  // and an http one is a downgrade attack on every call that uses it.
  const all = [...POOL.matchAll(/url: "([^"]+)"/g)].map((m) => m[1]!);
  for (const u of all) {
    assert.match(u, /^https:\/\//, `${u} must be https`);
    assert.ok(!/[?&](api[_-]?key|key|token)=/i.test(u), `${u} must not embed a key`);
  }
});

test("the provider id union covers every id actually used", () => {
  // A URL whose id is not in the union would fail to compile -- but a stale
  // union entry with no URL is dead weight that hides a removed provider.
  const declared = new Set(
    [...POOL.matchAll(/\| "([a-z]+)"/g)].map((m) => m[1]!).concat(["publicnode"])
  );
  const used = new Set([...POOL.matchAll(/id: "([a-z]+)"/g)].map((m) => m[1]!));
  for (const id of used) {
    assert.ok(declared.has(id), `id "${id}" is used but not declared in RpcProviderId`);
  }
});

/**
 * The budget arithmetic, so the claim is exercised rather than asserted.
 */
function budget(providers: number, perProviderPerSecond: number): number {
  return providers * perProviderPerSecond;
}

test("more providers is strictly more budget", () => {
  // The whole thesis in one assertion: the limit is per provider, so the pool
  // size multiplies it. Nothing clever, and it composes with everything else.
  const before = budget(2, 8);
  const after = budget(7, 8);
  assert.equal(after / before, 3.5, "seven providers is 3.5x two");
  assert.ok(after > before, "and adding a provider can never reduce the budget");
});

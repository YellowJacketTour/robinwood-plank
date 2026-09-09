import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { proofKey, isProof } from "../../lib/proof-cache";

/**
 * The proof cache: content-addressed bytes are fetched once, ever.
 *
 * Measured on the live site 2026-09-09. `/api/ipfs/metadata` on the homepage:
 * 10 calls, median 5,651 ms, 33.4 s in total, seven of them 500 -- from ONE
 * CID directory, at one instant, where three siblings succeeded. Neither a bad
 * CID nor a dead gateway. The gateway itself answered a real image in 4,478 ms
 * against a 5,000 ms limit: a success converted into a blank tile.
 *
 * The route already declared the data immutable for a year. Every response
 * carried `cf-cache-status: DYNAMIC`, so nothing was ever stored, and
 * lib/ipfs.ts fetched with `cache: "no-store"`. Right intent in three places,
 * zero effect.
 *
 * The dangerous half of this change is the write path: caching a MUTABLE body
 * forever is far worse than fetching it twice, so most of these tests are
 * about what must NOT be cached.
 */

const CACHE = readFileSync("lib/proof-cache.ts", "utf8").replace(/\r\n/g, "\n");
const ROUTE = readFileSync("app/api/ipfs/metadata/route.ts", "utf8").replace(/\r\n/g, "\n");
const IPFS = readFileSync("lib/ipfs.ts", "utf8").replace(/\r\n/g, "\n");

const CID = "bafybeictcaptbfswgepv2icnuw5wdhfjvvamwlcoza2p4qw3zbq2hqd6b4";

test("the same CID through different gateways is ONE proof", () => {
  // The whole point of content addressing, and exactly what keying on the full
  // gateway URL threw away: a gateway rotation must not cause a second fetch.
  const viaProtocol = proofKey(`ipfs://${CID}/1542`);
  const viaPinata = proofKey(`https://gateway.pinata.cloud/ipfs/${CID}/1542`);
  const viaDweb = proofKey(`https://dweb.link/ipfs/${CID}/1542`);
  assert.ok(viaProtocol, "an ipfs:// URI must key");
  assert.equal(viaPinata, viaProtocol, "pinata and ipfs:// must agree");
  assert.equal(viaDweb, viaProtocol, "every gateway must agree");
});

test("different paths under one CID are different proofs", () => {
  // The homepage bug in miniature: tokens 1541 and 1542 share a directory and
  // are not the same bytes. Collapsing them would serve one token's metadata
  // for another.
  assert.notEqual(proofKey(`ipfs://${CID}/1541`), proofKey(`ipfs://${CID}/1542`));
});

test("a bare CID keys without a path", () => {
  const k = proofKey(`ipfs://${CID}`);
  assert.ok(k && k.includes(CID.toLowerCase()));
  assert.ok(!k.endsWith("/"), "no trailing separator for a bare CID");
});

test("query strings and fragments do not fork the key", () => {
  // ?w=512&cv=3 is a rendering parameter on OUR side, not part of the bytes.
  const plain = proofKey(`https://gateway.pinata.cloud/ipfs/${CID}/a.png`);
  assert.equal(proofKey(`https://gateway.pinata.cloud/ipfs/${CID}/a.png?w=512&cv=3`), plain);
  assert.equal(proofKey(`https://gateway.pinata.cloud/ipfs/${CID}/a.png#x`), plain);
});

test("a MUTABLE url is never cacheable", () => {
  // The load-bearing refusal. Two hosts may serve different bytes for one
  // path, and the same host may serve different bytes tomorrow. A shared key
  // here would serve one host's answer as everyone's, for ten years.
  assert.equal(proofKey("https://api.example.com/token/1"), null);
  assert.equal(proofKey("https://arweave.net/some-tx-id"), null, "not a CID shape");
  assert.equal(proofKey("data:application/json,{}"), null);
  assert.equal(proofKey(""), null);
  assert.equal(proofKey("   "), null);
  assert.equal(isProof("https://api.example.com/token/1"), false);
});

test("v0 CIDs are recognised too", () => {
  const v0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  assert.ok(proofKey(`ipfs://${v0}/1`), "Qm... is content-addressed");
  assert.ok(isProof(`https://ipfs.io/ipfs/${v0}`));
});

test("the write path refuses anything without a key", () => {
  // A cache that stores what it cannot name is a cache that serves the wrong
  // bytes. Asserted on the source because the guard is the early return.
  const at = CACHE.indexOf("export async function writeProof");
  assert.ok(at > 0);
  const body = CACHE.slice(at, CACHE.length);
  assert.match(body, /if \(!key\) return false;/, "no key means no write");
  assert.match(body, /value === undefined \|\| value === null/, "and no empty writes");
});

test("a cache failure degrades to a refetch, never to an error", () => {
  // Silence would be the worse bug: a misbehaving backend must cost latency,
  // not data.
  const at = CACHE.indexOf("export async function readProof");
  const body = CACHE.slice(at, CACHE.indexOf("export async function writeProof"));
  assert.match(body, /catch\s*\{\s*return null;\s*\}/, "a read failure returns null");
});

test("the route reads the cache BEFORE fetching a gateway", () => {
  const at = ROUTE.indexOf("readProof");
  const fetchAt = ROUTE.indexOf("await fetchNftMetadata");
  assert.ok(at > 0 && fetchAt > at, "the cache must be consulted first, or it saves nothing");
  assert.match(ROUTE, /await writeProof\(uri, metadata\)/, "and a fresh fetch must be stored");
});

test("the gateway timeout is no longer shorter than a real gateway", () => {
  // Measured: pinata answered in 4,478 ms against a 5,000 ms limit. The limit
  // was tight only because the cost was paid on every request; with the proof
  // cache it is paid once.
  const m = IPFS.match(/export const GATEWAY_TIMEOUT_MS = ([\d_]+);/);
  assert.ok(m, "the timeout must exist");
  const ms = Number(m[1]!.replace(/_/g, ""));
  assert.ok(ms > 5_000, `a 4.5 s gateway must not be cut off (saw ${ms} ms)`);
  assert.ok(ms <= 30_000, `but a hung gateway must not hold a request forever (saw ${ms} ms)`);
});

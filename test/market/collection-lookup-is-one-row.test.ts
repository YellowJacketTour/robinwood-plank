import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
// execFileSync with an argument array: no shell, nothing interpolated.
import { execFileSync } from "node:child_process";
import { hasPostgresConfig, postgresQuery, closePostgres } from "../../lib/postgres";
import { upsertTrackedCollection, listTrackedCollections, getTrackedCollection, listTrackedCollectionsForChain } from "../../lib/market/multichain/store";
import { getCollectionAsync } from "../../lib/market/collections-server";

const SKIP = { skip: !hasPostgresConfig() };
// Line endings normalized: this repo checks out CRLF on Windows, and the
// body slice below searches for "\n}\n". On a CRLF checkout that matched
// nothing, leaving a two-character string that every assertion then
// "passed" against -- a test that measured nothing while reporting green.
const SRC = readFileSync("lib/market/collections-server.ts", "utf8").replace(/\r\n/g, "\n");

test("the auto-discovered lookup reads ONE row by its key, never the whole catalog", () => {
  const fn = SRC.slice(SRC.indexOf("export async function getCollectionAsync"));
  const end = fn.indexOf("\n}\n");
  // Guard the slice itself: if it ever fails to find the end of the function,
  // say so loudly instead of asserting against a fragment.
  assert.ok(end > 0, "the function body must be locatable, or the assertions below measure nothing");
  const body = fn.slice(0, end + 3);
  assert.ok(body.length > 200, `the body slice is implausibly short (${body.length} chars) -- it is not reading the function`);
  // The comments deliberately NAME the old call (explaining what was removed
  // and why). Strip them so this reads the code, not the prose about it.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  assert.match(code, /getTrackedCollection\("robinhood", slug\)/, "the keyed single-row reader");
  assert.doesNotMatch(code, /listTrackedCollections/, "a full-table read must never sit on a request path lookup");
  assert.doesNotMatch(code, /\.find\(/, "and no JS scan over the catalog");
});

test("no request-path route reaches for the whole catalog either", () => {
  // listTrackedCollections is legitimate in workers and scripts. It is not
  // legitimate inside app/api, where a visitor waits for it.
  // A CALL, not a mention: `listTrackedCollections(` with the open paren, so
  // a comment explaining what was removed does not fail this, and the
  // chain-scoped `listTrackedCollectionsForChain(` -- whose name contains the
  // old one -- is not mistaken for it.
  let hits = "";
  try {
    hits = execFileSync("git", ["grep", "-nE", "\\blistTrackedCollections\\(", "--", "app/api"], { encoding: "utf8" });
  } catch {
    hits = ""; // git grep exits 1 when there are no matches
  }
  assert.equal(hits.trim(), "", `an API route reads every tracked collection:\n${hits}`);

  // The guard must reject the shape it exists to reject, or it is a mirror.
  let control = "";
  try {
    control = execFileSync("git", ["grep", "-nE", "\\blistTrackedCollections\\(", "--", "lib", "scripts"], { encoding: "utf8" });
  } catch {
    control = "";
  }
  assert.ok(control.trim().length > 0, "the pattern must still find the real call where it legitimately lives (workers/scripts)");
});

test("the keyed read returns exactly what the scan returned, for a real row", SKIP, async () => {
  const address = `0x${Date.now().toString(16).padStart(40, "0")}`.slice(0, 42);
  let id: number | undefined;
  try {
    id = await upsertTrackedCollection({ chainSlug: "robinhood", chainId: null, contractAddress: address, adapter: "test" });

    // What the old code did: every row, then find() on the array.
    const all = await listTrackedCollections();
    const scanned = all.find((c) => c.chainSlug === "robinhood" && c.contractAddress.toLowerCase() === address.toLowerCase());
    // What the new code does.
    const keyed = await getTrackedCollection("robinhood", address);
    assert.ok(scanned, "the seeded row must be visible to the old shape, or this proves nothing");
    assert.equal(keyed?.contractAddress, scanned.contractAddress);
    assert.equal(keyed?.chainSlug, scanned.chainSlug);
    assert.equal(keyed?.tokenStandard ?? null, scanned.tokenStandard ?? null);

    // And the caller's own result is built from it.
    const collection = await getCollectionAsync(address);
    assert.equal(collection?.contractAddress, address);
    assert.equal(collection?.slug, address);

    // Case-insensitivity survived the change: the scan lowercased both sides.
    const upper = await getCollectionAsync(address.toUpperCase().replace("0X", "0x"));
    assert.equal(upper?.contractAddress, address);

    // A collection on another chain is still not a Robinhood-chain row.
    const other = `0x${(Date.now() + 1).toString(16).padStart(40, "1")}`.slice(0, 42);
    const otherId = await upsertTrackedCollection({ chainSlug: "eth-mainnet", chainId: 1, contractAddress: other, adapter: "test" });
    try {
      assert.equal(await getCollectionAsync(other), undefined, "a foreign-chain row must not resolve as a home-chain collection");
    } finally {
      await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id=$1`, [otherId]);
    }

    // A non-address slug never touches the database at all.
    assert.equal(await getCollectionAsync("not-an-address"), undefined);
  } finally {
    if (id != null) await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id=$1`, [id]);
  }
});

test("a chain's own list is read by chain, with that chain's total -- not the whole catalog", SKIP, async () => {
  const made: number[] = [];
  try {
    for (let i = 0; i < 3; i += 1) {
      const address = `0x${(Date.now() + i).toString(16).padStart(40, "2")}`.slice(0, 42);
      made.push(await upsertTrackedCollection({ chainSlug: "robinhood", chainId: null, contractAddress: address, adapter: "test" }));
    }
    const all = await listTrackedCollections();
    const scanned = all.filter((c) => c.chainSlug === "robinhood");

    const whole = await listTrackedCollectionsForChain("robinhood", { offset: 0, limit: 100_000 });
    assert.equal(whole.totalCount, scanned.length, "the count must equal what the filter-in-JS shape counted");
    assert.deepEqual(
      whole.collections.map((c) => c.contractAddress).sort(),
      scanned.map((c) => c.contractAddress).sort(),
      "and the rows must be the same rows",
    );

    // Windowing: page 2 continues where page 1 stopped, no overlap, no gap.
    const ordered = [...scanned].sort((a, b) => a.contractAddress.localeCompare(b.contractAddress)).map((c) => c.contractAddress);
    const first = await listTrackedCollectionsForChain("robinhood", { offset: 0, limit: 2 });
    const second = await listTrackedCollectionsForChain("robinhood", { offset: 2, limit: 2 });
    assert.deepEqual(first.collections.map((c) => c.contractAddress), ordered.slice(0, 2));
    assert.deepEqual(second.collections.map((c) => c.contractAddress), ordered.slice(2, 4));
    assert.equal(second.totalCount, whole.totalCount, "the total is the chain's, not the page's");

    // Another chain's rows are not in it.
    const foreign = `0x${(Date.now() + 9).toString(16).padStart(40, "3")}`.slice(0, 42);
    const foreignId = await upsertTrackedCollection({ chainSlug: "eth-mainnet", chainId: 1, contractAddress: foreign, adapter: "test" });
    try {
      const after = await listTrackedCollectionsForChain("robinhood", { offset: 0, limit: 100_000 });
      assert.equal(after.totalCount, whole.totalCount, "a foreign-chain row must not change this chain's total");
      assert.ok(!after.collections.some((c) => c.contractAddress === foreign));
    } finally {
      await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id=$1`, [foreignId]);
    }
  } finally {
    if (made.length) await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id=ANY($1::bigint[])`, [made]);
  }
});

after(closePostgres);

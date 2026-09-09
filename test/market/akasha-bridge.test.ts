import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * The tape -> catalog bridge, and the identity rule that keeps it honest.
 *
 * Before this lane existed the archive and the catalog were sealed rooms:
 * the hose wrote six akasha_* tables, the UI read plank_multichain_collections,
 * and no file imported both. Measured on production 2026-09-09, Bitcoin sat
 * frozen at 19,621 collections while the hose walked real blocks and parsed
 * real inscriptions -- because nothing carried one to the other.
 *
 * The identity rule is the part that must not drift. An inscription is a
 * TOKEN. The only collection signal that is a chain fact and not a vendor
 * opinion is the Ordinals parent declaration (envelope tag 3), which the
 * cluster layer already treats as its strongest hard edge. Mint a row per
 * declared parent and the count means something; mint one per inscription
 * and the number goes up while the archive gets worse.
 */

const BRIDGE = readFileSync("lib/market/multichain/discovery/akasha-bridge.ts", "utf8").replace(
  /\r\n/g,
  "\n"
);
const MIGRATION = readFileSync(
  "deploy/inmotion/postgres/migrations/104_akasha_tape.sql",
  "utf8"
).replace(/\r\n/g, "\n");

test("the bridge reads the tape and writes the catalog -- it joins both rooms", () => {
  assert.match(BRIDGE, /from ["']@\/lib\/market\/multichain\/store["']/,
    "must import the catalog's only writer");
  assert.match(BRIDGE, /upsertTrackedCollection\(/, "must actually upsert a collection");
  assert.match(BRIDGE, /FROM akasha_event/, "must read the tape");
});

test("every column and table the bridge queries exists in migration 104", () => {
  // Recomputed against the migration text rather than trusted: a bridge that
  // queries a column that does not exist fails only in production, and only
  // once the tape has rows.
  assert.match(MIGRATION, /CREATE TABLE IF NOT EXISTS akasha_event/);
  for (const column of ["chain", "kind", "token_or_inscription", "raw"]) {
    assert.match(
      MIGRATION,
      new RegExp(`^\\s+${column}\\s`, "m"),
      `akasha_event.${column} must exist for the bridge's query`
    );
    assert.ok(BRIDGE.includes(column), `the bridge should reference ${column}`);
  }
  // `raw` must be JSONB for the ->> operator the bridge uses.
  assert.match(MIGRATION, /raw\s+JSONB NOT NULL/, "raw must be JSONB for ->>'parent'");
});

test("identity: a collection is minted per declared PARENT, never per inscription", () => {
  assert.match(BRIDGE, /raw->>'parent'/, "the parent declaration is the key");
  assert.match(BRIDGE, /GROUP BY e\.raw->>'parent'/, "one row per parent, not per event");
  assert.match(
    BRIDGE,
    /raw->>'parent' IS NOT NULL/,
    "an inscription with no declared parent must not become a collection"
  );
});

/**
 * The id shape the bridge accepts, mirrored here so the rule can be exercised
 * directly rather than only asserted as text.
 */
const INSCRIPTION_ID = /^[0-9a-f]{64}i\d+$/i;

test("only well-formed inscription ids become catalog rows", () => {
  const txid = "a".repeat(64);
  assert.ok(INSCRIPTION_ID.test(`${txid}i0`), "a real inscription id is accepted");
  assert.ok(INSCRIPTION_ID.test(`${txid}i42`));
  // The shapes a vendor slug would take. These are exactly what must NOT
  // become a collection key: accepting them would let a decode error mint
  // catalog rows and the count would rise on garbage.
  assert.ok(!INSCRIPTION_ID.test("bitcoin-frogs"), "a vendor slug is not an inscription id");
  assert.ok(!INSCRIPTION_ID.test(txid), "a bare txid has no inscription index");
  assert.ok(!INSCRIPTION_ID.test(`${txid}i`), "an empty index is malformed");
  assert.ok(!INSCRIPTION_ID.test(`${"z".repeat(64)}i0`), "non-hex is malformed");
  assert.ok(!INSCRIPTION_ID.test(""), "empty is malformed");
});

test("a malformed parent is COUNTED, not silently dropped", () => {
  // A bridge that quietly skips rows is how a catalog goes stale while every
  // log line looks healthy -- the failure species this codebase keeps making.
  assert.match(BRIDGE, /malformedParents/, "malformed parents must be reported");
  assert.match(BRIDGE, /malformed \+= 1/, "and actually counted");
});

test("a missing tape is distinguishable from an empty one", () => {
  // "No rows" and "no table" are different facts. Collapsing them would let a
  // deploy that never applied migration 104 look like a quiet chain.
  assert.match(BRIDGE, /TAPE_MISSING/, "a missing table must report itself");
  assert.match(BRIDGE, /tapeEmpty/, "an empty tape is its own, separate state");
});

test("the bridge claims existence only -- no floors, listings or traits", () => {
  // Order is fixed: existence, then present-completeness, then bandwidth,
  // then speech. A bridge that wrote a floor would be speaking ahead of the
  // tape, which is the one thing the archive must never do.
  for (const forbidden of ["floorPrice", "floor_price", "listedCount", "updateCollectionMarketStats"]) {
    assert.ok(
      !BRIDGE.includes(forbidden),
      `the existence lane must not write ${forbidden}`
    );
  }
});

test("the pass is deterministic, so two runs walk the same ground", () => {
  assert.match(BRIDGE, /ORDER BY/, "an unordered LIMIT samples randomly");
  assert.match(BRIDGE, /LIMIT \$1/, "the pass must be bounded");
});

/**
 * The cutover must be a HAND-OFF, not a switch-off.
 *
 * activeMeshLanes() used to be purely subtractive: the flag removed four
 * vendor pagers and put nothing in their place, because the hose had no way
 * to write a catalog row. Arming it left Bitcoin existence with NO writer --
 * the exact outcome matrix.ts's own comment warns about, reachable by setting
 * the flag that comment describes. It was armed on production 2026-09-09 and
 * disarmed once measured.
 */
test("arming the cutover schedules the bridge that replaces the pagers", async () => {
  const { MESH_LANES, BITCOIN_CATALOG_LANES, activeMeshLanes } = await import(
    "../../lib/market/multichain/mesh/matrix"
  );
  const prev = process.env.AKASHA_HOSE_OWNS_BITCOIN;
  try {
    process.env.AKASHA_HOSE_OWNS_BITCOIN = "1";
    const active = activeMeshLanes();

    // The pagers are gone...
    for (const source of BITCOIN_CATALOG_LANES) {
      assert.ok(
        !active.some((l) => l.chainSlug === "bitcoin-mainnet" && l.source === source),
        `${source} must be retired while the hose owns existence`
      );
    }
    // ...and a writer took their place. Without this the cutover is a
    // regression dressed as progress.
    assert.ok(
      active.some((l) => l.chainSlug === "bitcoin-mainnet" && l.source === "akasha-bridge"),
      "the bridge must be scheduled to receive the hand-off"
    );
    // Bitcoin is never left dark: other lanes keep running.
    assert.ok(
      active.filter((l) => l.chainSlug === "bitcoin-mainnet").length > 1,
      "Bitcoin must keep more than just the bridge"
    );
    assert.ok(MESH_LANES.length > active.length, "the flag must actually subtract something");
  } finally {
    if (prev === undefined) delete process.env.AKASHA_HOSE_OWNS_BITCOIN;
    else process.env.AKASHA_HOSE_OWNS_BITCOIN = prev;
  }
});

test("the bridge lane runs even while the cutover is disarmed", async () => {
  // It adds what the chain knows and the vendors do not, so there is no
  // reason to gate it behind the flag -- and when the pagers retire it is
  // already the writer rather than a cold start.
  const { activeMeshLanes } = await import("../../lib/market/multichain/mesh/matrix");
  const prev = process.env.AKASHA_HOSE_OWNS_BITCOIN;
  try {
    delete process.env.AKASHA_HOSE_OWNS_BITCOIN;
    assert.ok(
      activeMeshLanes().some(
        (l) => l.chainSlug === "bitcoin-mainnet" && l.source === "akasha-bridge"
      ),
      "the bridge must run whether or not the cutover is armed"
    );
  } finally {
    if (prev === undefined) delete process.env.AKASHA_HOSE_OWNS_BITCOIN;
    else process.env.AKASHA_HOSE_OWNS_BITCOIN = prev;
  }
});

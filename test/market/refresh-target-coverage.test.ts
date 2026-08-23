import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../scripts/refresh-market-data.ts", import.meta.url), "utf8");

/** A refresh step can be perfectly implemented yet never run when its name is
 * omitted from the default target registry. That silent scheduler regression
 * previously skipped canonical membership and fill ingestion. */
test("default refresh modes include every live completeness lane", () => {
  for (const target of [
    "hydrate-bitcoin-membership",
    "hydrate-solana-membership",
    "seaport-fills",
    "seaport-fills-backfill",
    "cryptopunks-native-book",
    "robinwood-floor-observation",
  ]) {
    const occurrences = source.split(`\"${target}\"`).length - 1;
    assert.ok(source.includes(`\"--${target}\"`), `${target} must be explicitly selectable`);
    assert.ok(occurrences >= 3, `${target} must appear in full, incremental, and step registries`);
  }
});

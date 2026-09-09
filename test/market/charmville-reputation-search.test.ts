import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePineSearch } from "../../lib/charmville/reputation-search";
import { encodePineSearch } from "../../lib/charmville/reputation-query";
import type { ReputationFilter } from "../../lib/charmville/reputation";

test("reputation search accepts exact decimal counts without floating point conversion", () => {
  const search = parsePineSearch(new URLSearchParams("q=cozy&face=gleam&basis=lifetime&metric=supporters&minimum=9007199254740993&direction=asc"));
  assert.equal(search.minimum, "9007199254740993");
  assert.equal(search.metric, "supporters");
  assert.equal(search.q, "cozy");
  assert.equal(parsePineSearch(new URLSearchParams()).face, "stalk");
});

test("shared reputation queries preserve nested predicates and exact inclusive ranges", () => {
  const filter: ReputationFilter = { op: "all", children: [
    { op: "between", face: "stalk", basis: "current", metric: "totals", min: "0", max: "9007199254740993" },
    { op: "any", children: [{ op: "eq", face: "gleam", basis: "lifetime", metric: "supporters", value: "2" },
      { op: "not", child: { op: "lte", face: "hum", basis: "current", metric: "totals", value: "4" } }] },
  ] };
  const search = { ...parsePineSearch(new URLSearchParams("q=cozy+garden")), filter };
  assert.deepEqual(parsePineSearch(encodePineSearch(search)), search);
  for (const invalid of ["null", "{}", "{", JSON.stringify({ op: "all", children: [] }), JSON.stringify({ op: "between", face: "stalk", basis: "current", metric: "totals", min: "2", max: "1" })]) {
    assert.throws(() => parsePineSearch(new URLSearchParams({ filter: invalid })));
  }
  assert.throws(() => parsePineSearch(new URLSearchParams({ filter: " ".repeat(16001) })), /too large/);
});

test("reputation search rejects malformed public query values", () => {
  for (const query of ["minimum=-1", "minimum=1e9", "minimum=01", "face=unknown", "basis=inventory", "direction=random", "metric=wallets", `q=${"x".repeat(201)}`, `minimum=${"9".repeat(41)}`]) {
    assert.throws(() => parsePineSearch(new URLSearchParams(query)), /Choose a valid/);
  }
});

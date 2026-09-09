import { test } from "node:test";
import assert from "node:assert/strict";
import { projectReputation, discoverReputation, validateReputationFilter, type AcceptedReaction, type ReputationFilter } from "../../lib/charmville/reputation";

const acceptance = (receiptId: string, profileId: string, quantity: string, active = true): AcceptedReaction => ({ receiptId, profileId, contentId: "pine:1", face: "stalk", quantity, active });
const metric = { face: "stalk", basis: "current", metric: "totals" } as const;
test("receipt retries do not inflate totals, supporters use profile identity, removal affects only current", () => {
  const first = acceptance("r1", "profile-a", "2");
  const rows = projectReputation(["pine:1", "pine:2"], [first, first, acceptance("r2", "profile-a", "3", false), acceptance("r3", "profile-b", "1", false)]);
  assert.deepEqual(rows[0].counts.stalk, { current: { totals: "2", supporters: "1" }, lifetime: { totals: "6", supporters: "2" } });
  assert.equal(rows[1].counts.gleam.lifetime.totals, "0");
  assert.throws(() => projectReputation(["pine:1"], [first, { ...first, quantity: "3" }]), /Conflicting receipt/);
});
test("ineligible content never enters counts or zero-match discovery", () => {
  const rows = projectReputation(["pine:2"], [acceptance("r1", "private-profile", "999")]);
  assert.deepEqual(discoverReputation(rows, { ...metric, op: "eq", value: "0" }).map(r => r.contentId), ["pine:2"]);
});
test("nested ALL/ANY/NOT and inclusive thresholds retain their meaning", () => {
  const rows = projectReputation(["pine:1", "pine:2"], [acceptance("r1", "a", "3")]);
  const filter: ReputationFilter = { op: "all", children: [
    { ...metric, op: "between", min: "3", max: "3" },
    { op: "any", children: [{ ...metric, op: "gte", value: "100" }, { op: "not", child: { ...metric, op: "lte", value: "2" } }] },
  ] };
  assert.deepEqual(discoverReputation(rows, filter).map(r => r.contentId), ["pine:1"]);
  assert.deepEqual(discoverReputation(rows, { op: "not", child: filter }).map(r => r.contentId), ["pine:2"]);
});
test("large counts remain exact, sorting has deterministic ties and leaves the snapshot intact", () => {
  const rows = projectReputation(["pine:2", "pine:1", "pine:3"], [acceptance("r1", "a", "9007199254740993")]);
  const sorted = discoverReputation(rows, undefined, [{ ...metric, direction: "desc" }]);
  assert.deepEqual(sorted.map(r => r.contentId), ["pine:1", "pine:2", "pine:3"]);
  assert.equal(sorted[0].counts.stalk.current.totals, "9007199254740993");
  assert.deepEqual(rows.map(r => r.contentId), ["pine:2", "pine:1", "pine:3"]);
  const later = projectReputation(["pine:1"], [acceptance("r2", "b", "100")]);
  assert.equal(later[0].counts.stalk.current.totals, "100");
  assert.equal(sorted[0].counts.stalk.current.totals, "9007199254740993");
});
test("malformed and unbounded queries fail before discovery", () => {
  for (const value of ["-1", "1.1", "01", "NaN", "1e3"]) assert.throws(() => validateReputationFilter({ ...metric, op: "eq", value }));
  assert.throws(() => validateReputationFilter({ ...metric, op: "between", min: "5", max: "2" }));
  assert.throws(() => validateReputationFilter({ op: "all", children: [] }));
  let deep: ReputationFilter = { ...metric, op: "eq", value: "0" };
  for (let i = 0; i < 15; i++) deep = { op: "not", child: deep };
  assert.throws(() => validateReputationFilter(deep), /complex/);
});

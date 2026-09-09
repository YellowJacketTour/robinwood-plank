import assert from "node:assert/strict";
import test from "node:test";
import { applyProjectionFields } from "../../lib/market/multichain/edge/projection-patch";

test("sparse updates retain fields they do not own but apply real zero and expired null", () => {
  const current = { floor: "100" as string | null, sales: 4, holders: 298 };
  const result = applyProjectionFields(current, { sales: 0, floor: null }, ["floor", "sales", "holders"]);
  assert.deepEqual(result, { floor: null, sales: 0, holders: 298 });
  assert.deepEqual(current, { floor: "100", sales: 4, holders: 298 });
  assert.deepEqual(applyProjectionFields(current, { holders: undefined }, ["holders"]), current);
});

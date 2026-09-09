import { test } from "node:test";
import assert from "node:assert/strict";
import { inventoryCompartments } from "../../lib/charmville/inventory";

test("inventory compartments preserve exact balances and separate seeds from spendable Charms", () => {
  const inventory = { seeds: [{ face: "stalk", qty: "2" }], faces: [{ face: "stalk", qty: "9007199254740993" }], grain: "9007199254740995" };
  const before = structuredClone(inventory);
  const views = inventoryCompartments(inventory);
  assert.strictEqual(views.gameplay.seeds, inventory.seeds);
  assert.strictEqual(views.satchel.charms, inventory.faces);
  assert.equal(views.currency.grain, "9007199254740995");
  assert.deepEqual(inventory, before);
  assert.deepEqual(Object.keys(views.gameplay), ["seeds"]);
});

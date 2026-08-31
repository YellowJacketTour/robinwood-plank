import assert from "node:assert/strict";
import test from "node:test";
import { ACTION_STAGES, actionStatusText, advanceActionState } from "../../public/arcade/transaction-lifecycle.js";

test("transaction lifecycle distinguishes intention, submission, inclusion, and game acceptance", () => {
  let state = advanceActionState(null, ACTION_STAGES.INTENT, { action: "lock" });
  state = advanceActionState(state, ACTION_STAGES.SIGNING);
  state = advanceActionState(state, ACTION_STAGES.SUBMITTED, { hash: "0xabc" });
  state = advanceActionState(state, ACTION_STAGES.INCLUDED, { blockNumber: 42 });
  state = advanceActionState(state, ACTION_STAGES.ACCEPTED);
  assert.match(actionStatusText(state), /ACCEPTED BY GAME/);
  assert.equal(state.hash, "0xabc");
});

test("transaction lifecycle rejects impossible optimistic transitions", () => {
  assert.throws(() => advanceActionState(null, ACTION_STAGES.ACCEPTED), /invalid action transition/);
  const submitted = advanceActionState(advanceActionState(null, ACTION_STAGES.INTENT, { action: "bet" }), ACTION_STAGES.SUBMITTED);
  assert.throws(() => advanceActionState(submitted, ACTION_STAGES.ACCEPTED), /invalid action transition/);
});


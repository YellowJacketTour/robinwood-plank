import assert from "node:assert/strict";
import test from "node:test";

import {
  DrandRoundUnavailableError,
  settleVault,
  type VaultRelayPort,
} from "../../scripts/relay-drand";

const VAULT = "0x1111111111111111111111111111111111111111";
const REQUESTER = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";

function fakePort(
  overrides: Partial<VaultRelayPort> = {}
): VaultRelayPort {
  let requester = REQUESTER;
  return {
    pendingRequester: async () => requester,
    pendingRound: async () => ({ round: BigInt(100), available: true }),
    latestDrandRound: async () => BigInt(100),
    relayExactRound: async () => {},
    isRoundAvailable: async () => true,
    currentDrandRound: async () => BigInt(100),
    pin: async () => {},
    claim: async () => {
      requester = ZERO;
    },
    forfeit: async () => {
      requester = ZERO;
    },
    ...overrides,
  };
}

test("idle vault reports idle without performing actions", async () => {
  let acted = false;
  const port = fakePort({
    pendingRequester: async () => ZERO,
    pin: async () => {
      acted = true;
    },
  });
  assert.deepEqual(await settleVault(VAULT, port), {
    vault: VAULT,
    state: "idle",
    actionable: false,
  });
  assert.equal(acted, false);
});

test("future exact round reports waiting without spending gas", async () => {
  let acted = false;
  const port = fakePort({
    pendingRound: async () => ({ round: BigInt(101), available: false }),
    latestDrandRound: async () => BigInt(100),
    relayExactRound: async () => {
      acted = true;
    },
  });
  const value = await settleVault(VAULT, port);
  assert.equal(value.state, "waiting");
  assert.equal(value.actionable, false);
  assert.match(value.detail || "", /latest published drand round is 100/);
  assert.equal(acted, false);
});

test("published request relays its exact round, pins, claims, and confirms clear", async () => {
  let available = false;
  let requester = REQUESTER;
  const actions: string[] = [];
  const port = fakePort({
    pendingRequester: async () => requester,
    pendingRound: async () => ({ round: BigInt(123), available }),
    latestDrandRound: async () => BigInt(123),
    relayExactRound: async (round) => {
      actions.push(`relay:${round.toString()}`);
      available = true;
    },
    isRoundAvailable: async () => available,
    pin: async () => {
      actions.push("pin");
    },
    claim: async () => {
      actions.push("claim");
      requester = ZERO;
    },
  });
  const value = await settleVault(VAULT, port);
  assert.equal(value.state, "settled");
  assert.equal(value.actionable, false);
  assert.deepEqual(actions, ["relay:123", "pin", "claim"]);
});

test("expired unavailable request is forfeited and confirmed clear", async () => {
  let requester = REQUESTER;
  const port = fakePort({
    pendingRequester: async () => requester,
    pendingRound: async () => ({ round: BigInt(100), available: false }),
    latestDrandRound: async () => BigInt(30_000),
    relayExactRound: async (round) => {
      throw new DrandRoundUnavailableError(round);
    },
    currentDrandRound: async () => BigInt(30_000),
    forfeit: async () => {
      requester = ZERO;
    },
  });
  const value = await settleVault(VAULT, port);
  assert.equal(value.state, "forfeited");
  assert.equal(value.actionable, false);
});

test("action failure remains visible when the occupied slot remains", async () => {
  const port = fakePort({
    pin: async () => {
      throw new Error("execution reverted");
    },
  });
  const value = await settleVault(VAULT, port);
  assert.equal(value.state, "error");
  assert.equal(value.actionable, true);
  assert.match(value.detail || "", /pin failed: execution reverted/);
});

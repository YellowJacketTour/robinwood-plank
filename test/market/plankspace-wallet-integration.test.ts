import assert from "node:assert/strict";
import test from "node:test";

import {
  handleNativePlankSpaceWalletRequest,
  type NativeWalletBridgeDependencies,
} from "../../components/plankspace/native-wallet-bridge-core";

const connectedState = {
  address: "0x1111111111111111111111111111111111111111",
  chainId: 46630,
  status: "connected" as const,
  isConnected: true,
};

function dependencies(
  overrides: Partial<NativeWalletBridgeDependencies> = {},
): NativeWalletBridgeDependencies {
  return {
    getState: () => connectedState,
    openConnect: () => undefined,
    disconnect: () => undefined,
    signMessage: async () => "0xsigned",
    sendNativeTransaction: async () => "0xtx",
    ...overrides,
  };
}

test("native PlankSpace reads the master wallet state without requesting another provider", async () => {
  const result = await handleNativePlankSpaceWalletRequest(
    { method: "getState" },
    dependencies(),
  );

  assert.deepEqual(result, { state: connectedState });
});
test("native PlankSpace opens the master wallet modal when disconnected", async () => {
  let opened = 0;
  const result = await handleNativePlankSpaceWalletRequest(
    { method: "connect" },
    dependencies({
      getState: () => ({
        address: null,
        chainId: null,
        status: "disconnected",
        isConnected: false,
      }),
      openConnect: () => {
        opened += 1;
      },
    }),
  );

  assert.equal(opened, 1);
  assert.deepEqual(result, { pending: true });
});

test("native PlankSpace rejects signatures for another wallet or an unknown message", async () => {
  await assert.rejects(
    handleNativePlankSpaceWalletRequest(
      {
        method: "signMessage",
        payload: {
          address: "0x2222222222222222222222222222222222222222",
          message: "PlankSpace wallet verification\nunsafe",
        },
      },
      dependencies(),
    ),
    /owns this profile/,
  );

  await assert.rejects(
    handleNativePlankSpaceWalletRequest(
      {
        method: "signMessage",
        payload: {
          address: connectedState.address,
          message: "Sign away everything",
        },
      },
      dependencies(),
    ),
    /unknown signature request/,
  );
});

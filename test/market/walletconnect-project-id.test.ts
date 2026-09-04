import assert from "node:assert/strict";
import test from "node:test";

import { getWalletConnectProjectId } from "../../lib/wallet-connect";

test("WalletConnect always uses the single build-configured project ID", () => {
  const previous = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = "configured-project-id-1234567890";

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => "browser-override-project-id-0987654321",
    },
  });

  try {
    assert.equal(
      getWalletConnectProjectId(),
      "configured-project-id-1234567890",
    );
  } finally {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { localStorage?: unknown }).localStorage;
    if (previous === undefined) {
      delete process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    } else {
      process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID = previous;
    }
  }
});

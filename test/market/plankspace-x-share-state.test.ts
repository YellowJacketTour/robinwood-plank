import assert from "node:assert/strict";
import test from "node:test";

const { walletStateConfirmsDisconnect } = await import(
  new URL("../../integrations/plankspace-app/app/x-share-state.ts", import.meta.url).href
);

test("only an authoritative disconnected wallet state clears X sharing", () => {
  assert.equal(walletStateConfirmsDisconnect({ address: null, status: "connecting", isConnected: false }), false);
  assert.equal(walletStateConfirmsDisconnect({ address: null, status: "connected", isConnected: true }), false);
  assert.equal(walletStateConfirmsDisconnect({ address: null, status: "disconnected", isConnected: false }), true);
  assert.equal(walletStateConfirmsDisconnect({ address: "0xabc", status: "disconnected", isConnected: false }), false);
});

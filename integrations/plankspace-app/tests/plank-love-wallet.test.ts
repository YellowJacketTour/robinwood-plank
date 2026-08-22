import assert from "node:assert/strict";
import test from "node:test";

test("delegates connection and signing to the exact Plank.love parent origin", async () => {
  const sent: Array<Record<string, unknown>> = [];
  let onMessage: ((event: MessageEvent<unknown>) => void) | undefined;
  const parent = {
    postMessage(message: Record<string, unknown>, origin: string) {
      sent.push({ ...message, targetOrigin: origin });
    },
  };
  const fakeWindow = {
    parent,
    addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
      if (type === "message") onMessage = listener;
    },
  };

  Object.assign(globalThis, {
    window: fakeWindow,
    document: { referrer: "https://plank.love/plankspace" },
    sessionStorage: { getItem(){ return null; }, setItem(){} },
  });

  const bridge = await import("../app/plank-love-wallet");
  assert.equal(sent[0]?.type, "wallet:ready");
  assert.equal(sent[0]?.targetOrigin, "https://plank.love");

  const connectPromise = bridge.connectPlankLoveWallet();
  const connectRequest = sent.at(-1);
  assert.equal(connectRequest?.method, "connect");
  let settled = false;
  void connectPromise.finally(() => { settled = true; });
  onMessage?.({
    origin: "https://attacker.example",
    source: parent,
    data: {
      source: "plank-love-wallet-v1",
      type: "wallet:response",
      requestId: connectRequest?.requestId,
      result: { state: { address: "0xdead", chainId: 1, status: "connected", isConnected: true } },
    },
  } as unknown as MessageEvent<unknown>);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(settled, false);
  onMessage?.({
    origin: "https://plank.love",
    source: parent,
    data: {
      source: "plank-love-wallet-v1",
      type: "wallet:response",
      requestId: connectRequest?.requestId,
      result: {
        state: {
          address: "0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d",
          chainId: 4663,
          status: "connected",
          isConnected: true,
        },
      },
    },
  } as unknown as MessageEvent<unknown>);
  assert.equal(
    await connectPromise,
    "0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d"
  );

  const signPromise = bridge.signPlankLoveMessage(
    "PlankSpace wallet verification\nSite: https://plank.love/plankspace",
    "0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d"
  );
  const signRequest = sent.at(-1);
  assert.equal(signRequest?.method, "signMessage");
  onMessage?.({
    origin: "https://plank.love",
    source: parent,
    data: {
      source: "plank-love-wallet-v1",
      type: "wallet:response",
      requestId: signRequest?.requestId,
      result: { signature: "0xsigned" },
    },
  } as unknown as MessageEvent<unknown>);
  assert.equal(await signPromise, "0xsigned");
});

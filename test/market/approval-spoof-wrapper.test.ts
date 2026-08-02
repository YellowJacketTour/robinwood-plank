import assert from "node:assert/strict";
import { test } from "node:test";
import { Interface } from "ethers";
import { wrapProviderWithApprovalSpoof, type ApprovalSpoof } from "../../lib/market/seaport";

/**
 * Mechanism tests for wrapProviderWithApprovalSpoof — the ACTUAL exported
 * function fulfillOrder() (and sweepFloor's batch path) feeds seaport-js in
 * production, via getSeaport(approvalSpoofs). computeApprovalSpoof (see
 * approval-spoof.test.ts) decides WHETHER and WHICH triple(s) to spoof;
 * these tests instead prove the wrapper itself only ever answers calls
 * matching an entry in the list it was given, and passes every other
 * request straight through to the underlying wallet provider unmodified —
 * including near-miss calls (right selector, wrong address) that must NOT
 * be caught by the spoof.
 *
 * The exact call shape used here (selector + ABI-encoded args) is the same
 * one seaport-js's lib/utils/approval.js actually sends — proven against
 * real deployed Seaport 1.6 bytecode in
 * test/contracts/SeaportPerTokenApproval.test.ts (npm run test:contracts).
 */

const ERC721_IFACE = new Interface([
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
]);

const NFT = "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";
const OTHER_NFT = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const SEAPORT = "0x0000000000000068F116a894984e2DB1123eB395";
const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER_OWNER = "0x2222222222222222222222222222222222222222";

function isApprovedForAllCall(owner: string, operator: string) {
  return ERC721_IFACE.encodeFunctionData("isApprovedForAll", [owner, operator]);
}

function decodeBool(hex: string): boolean {
  return ERC721_IFACE.decodeFunctionResult("isApprovedForAll", hex)[0] as boolean;
}

/** Records every request that reaches the base provider, answering falsely
 * to every isApprovedForAll read — mirroring the live bug's actual reality
 * (a real per-token approval that isApprovedForAll cannot see). */
function fakeBaseProvider() {
  const calls: Array<{ method: string; params?: unknown }> = [];
  return {
    calls,
    provider: {
      request: async (args: { method: string; params?: unknown[] | object }) => {
        calls.push({ method: args.method, params: args.params });
        if (args.method === "eth_call") {
          return ERC721_IFACE.encodeFunctionResult("isApprovedForAll", [false]);
        }
        return "0xreal";
      },
      isMetaMask: true,
    },
  };
}

test("answers TRUE for exactly the spoofed (owner, token, operator) triple, without reaching the base provider", async () => {
  const { provider: base, calls } = fakeBaseProvider();
  const spoof: ApprovalSpoof = { owner: OWNER, token: NFT, operator: SEAPORT };
  const wrapped = wrapProviderWithApprovalSpoof(base, [spoof]);

  const result = await wrapped.request({
    method: "eth_call",
    params: [{ to: NFT, data: isApprovedForAllCall(OWNER, SEAPORT) }, "latest"],
  });

  assert.equal(decodeBool(result as string), true);
  assert.deepEqual(calls, [], "the spoofed call must never reach the real provider");
});

test("passes through a call on the SAME token but a DIFFERENT owner — real (false) answer", async () => {
  const { provider: base, calls } = fakeBaseProvider();
  const spoof: ApprovalSpoof = { owner: OWNER, token: NFT, operator: SEAPORT };
  const wrapped = wrapProviderWithApprovalSpoof(base, [spoof]);

  const result = await wrapped.request({
    method: "eth_call",
    params: [{ to: NFT, data: isApprovedForAllCall(OTHER_OWNER, SEAPORT) }, "latest"],
  });

  assert.equal(decodeBool(result as string), false);
  assert.equal(calls.length, 1, "a non-matching owner must reach the real provider");
});

test("passes through a call on a DIFFERENT token contract, same owner/operator", async () => {
  const { provider: base, calls } = fakeBaseProvider();
  const spoof: ApprovalSpoof = { owner: OWNER, token: NFT, operator: SEAPORT };
  const wrapped = wrapProviderWithApprovalSpoof(base, [spoof]);

  await wrapped.request({
    method: "eth_call",
    params: [{ to: OTHER_NFT, data: isApprovedForAllCall(OWNER, SEAPORT) }, "latest"],
  });

  assert.equal(calls.length, 1, "a non-matching token address must reach the real provider");
});

test("passes through every non-eth_call method untouched (eth_sendTransaction, eth_chainId, eth_accounts, ...)", async () => {
  const { provider: base, calls } = fakeBaseProvider();
  const spoof: ApprovalSpoof = { owner: OWNER, token: NFT, operator: SEAPORT };
  const wrapped = wrapProviderWithApprovalSpoof(base, [spoof]);

  await wrapped.request({ method: "eth_chainId" });
  await wrapped.request({ method: "eth_accounts" });
  await wrapped.request({
    method: "eth_sendTransaction",
    params: [{ to: SEAPORT, data: "0xdeadbeef" }],
  });

  assert.deepEqual(
    calls.map((c) => c.method),
    ["eth_chainId", "eth_accounts", "eth_sendTransaction"],
    "the wrapper must be a pass-through for everything except the one targeted read — " +
      "in particular the actual broadcast must reach the real wallet unmodified"
  );
});

test("passes through an eth_call to the right token/owner but a DIFFERENT operator (e.g. a conduit, not Seaport)", async () => {
  const { provider: base, calls } = fakeBaseProvider();
  const spoof: ApprovalSpoof = { owner: OWNER, token: NFT, operator: SEAPORT };
  const wrapped = wrapProviderWithApprovalSpoof(base, [spoof]);

  const someConduit = "0x1111111111111111111111111111111111111199";
  await wrapped.request({
    method: "eth_call",
    params: [{ to: NFT, data: isApprovedForAllCall(OWNER, someConduit) }, "latest"],
  });

  assert.equal(calls.length, 1, "a non-matching operator must reach the real provider");
});

test("passes through an eth_call to the right address with unrelated calldata (e.g. balanceOf, not isApprovedForAll)", async () => {
  const { provider: base, calls } = fakeBaseProvider();
  const spoof: ApprovalSpoof = { owner: OWNER, token: NFT, operator: SEAPORT };
  const wrapped = wrapProviderWithApprovalSpoof(base, [spoof]);

  const balanceOfIface = new Interface(["function balanceOf(address owner) view returns (uint256)"]);
  await wrapped.request({
    method: "eth_call",
    params: [{ to: NFT, data: balanceOfIface.encodeFunctionData("balanceOf", [OWNER]) }, "latest"],
  });

  assert.equal(calls.length, 1, "a different function selector on the same contract must not be spoofed");
});

test("other provider properties (on/removeListener/isMetaMask) delegate to the base provider with correct `this`", async () => {
  const events: string[] = [];
  const base = {
    request: async () => "0x",
    isMetaMask: true,
    on(event: string) {
      // Reading `this.isMetaMask` proves `this` is bound to the real base
      // provider object, not the Proxy or something unbound.
      events.push(`${event}:${this.isMetaMask}`);
    },
  };
  const spoof: ApprovalSpoof = { owner: OWNER, token: NFT, operator: SEAPORT };
  const wrapped = wrapProviderWithApprovalSpoof(base, [spoof]);

  assert.equal(wrapped.isMetaMask, true);
  wrapped.on?.("chainChanged", () => {});
  assert.deepEqual(events, ["chainChanged:true"]);
});

test("BATCH (sweepFloor): a list of several spoofs each answers TRUE only for its own triple", async () => {
  const { provider: base, calls } = fakeBaseProvider();
  const sellerA = "0x3333333333333333333333333333333333333333";
  const sellerB = "0x4444444444444444444444444444444444444444";
  const nftA = NFT;
  const nftB = OTHER_NFT;
  const spoofs: ApprovalSpoof[] = [
    { owner: sellerA, token: nftA, operator: SEAPORT },
    { owner: sellerB, token: nftB, operator: SEAPORT },
  ];
  const wrapped = wrapProviderWithApprovalSpoof(base, spoofs);

  const resultA = await wrapped.request({
    method: "eth_call",
    params: [{ to: nftA, data: isApprovedForAllCall(sellerA, SEAPORT) }, "latest"],
  });
  const resultB = await wrapped.request({
    method: "eth_call",
    params: [{ to: nftB, data: isApprovedForAllCall(sellerB, SEAPORT) }, "latest"],
  });
  // Cross the pairs: sellerA's approval on nftB was never confirmed — must
  // fall through to the real (false) read, not be treated as "close enough".
  const crossed = await wrapped.request({
    method: "eth_call",
    params: [{ to: nftB, data: isApprovedForAllCall(sellerA, SEAPORT) }, "latest"],
  });

  assert.equal(decodeBool(resultA as string), true);
  assert.equal(decodeBool(resultB as string), true);
  assert.equal(decodeBool(crossed as string), false);
  assert.equal(calls.length, 1, "only the crossed (unconfirmed) pairing should reach the real provider");
});

test("an empty spoof list is a pure pass-through — nothing is ever answered TRUE", async () => {
  const { provider: base, calls } = fakeBaseProvider();
  const wrapped = wrapProviderWithApprovalSpoof(base, []);

  const result = await wrapped.request({
    method: "eth_call",
    params: [{ to: NFT, data: isApprovedForAllCall(OWNER, SEAPORT) }, "latest"],
  });

  assert.equal(decodeBool(result as string), false);
  assert.equal(calls.length, 1);
});

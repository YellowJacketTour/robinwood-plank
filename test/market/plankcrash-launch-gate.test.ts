import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Wallet, getBytes } from "ethers";
import { validateCanary } from "../../scripts/lib/plankcrash-canary-validation.js";
import { canonicalJson, sha256Hex } from "../../scripts/lib/testnet-canary-evidence.js";

const signer = Wallet.createRandom();
const now = Date.now();
async function evidence(change: Record<string, unknown> = {}) {
  const names = ["crash", "bank", "lottery", "rakeRouter", "beacon"];
  let sequence = 0;
  const receipt = (operation: string) => ({ operation, transactionHash: `0x${(++sequence).toString(16).padStart(64, "0")}`, blockHash: `0x${"ab".repeat(32)}`, blockNumber: sequence, status: 1, gasUsed: "21000", effectiveGasPriceWei: "2", totalGasCostWei: "42000" });
  const unsigned = {
    schema: "plankcrash-testnet-canary/v1", chainId: 46630, network: "robinhood-testnet", mode: "fresh-stack-lifecycle", generatedAt: new Date(now).toISOString(), signer: signer.address,
    addresses: Object.fromEntries(names.map((name, i) => [name, `0x${(i + 1).toString(16).padStart(40, "0")}`])),
    codeHashes: Object.fromEntries(names.map(name => [name, `0x${"cd".repeat(32)}`])),
    assertions: Object.fromEntries(["crashBeacon", "crashRouter", "crashLottery", "crashSettlesCappedPool", "lotterySource", "routerSource", "routerLottery", "routerVault", "bankAllowsCrash"].map(name => [name, true])),
    transactions: ["beacon:setRandomness:sentinel", "crash:placeBet", "crash:lockRound", "beacon:setRandomness:round", "crash:settleRound"].map(receipt),
    deploymentReceipts: names.map(name => receipt(`deploy:${name}`)), ...change,
  };
  const payloadSha256 = sha256Hex(canonicalJson(unsigned));
  return { ...unsigned, payloadSha256, signature: await signer.signMessage(getBytes(payloadSha256)), recoveredSigner: signer.address };
}

test("authenticates complete lifecycle evidence in the producer's actual format", async () => {
  assert.deepEqual(validateCanary(await evidence(), signer.address, now), []);
});
test("rejects missing/empty assertions, sentinel-only runs and missing receipts", async () => {
  for (const change of [{ assertions: {} }, { mode: "non-invasive-sentinel" }, { transactions: [] }, { deploymentReceipts: [] }, { codeHashes: {} }]) {
    assert.ok(validateCanary(await evidence(change), signer.address, now).length > 0);
  }
});
test("rejects tampering, wrong signer, expired and future evidence", async () => {
  const valid = await evidence();
  assert.ok(validateCanary({ ...valid, mode: "tampered" }, signer.address, now).some(e => e.includes("signature")));
  assert.ok(validateCanary(valid, Wallet.createRandom().address, now).some(e => e.includes("signature")));
  assert.ok(validateCanary(valid, "", now).some(e => e.includes("signature")));
  for (const timestamp of [now - 8 * 86_400_000, now + 120_000]) assert.ok(validateCanary(await evidence({ generatedAt: new Date(timestamp).toISOString() }), signer.address, now).some(e => e.includes("seven days")));
});
test("rejects receipt reuse and forged gas totals even when signed", async () => {
  const valid = await evidence();
  const duplicate = valid.transactions.map(r => ({ ...r, transactionHash: valid.transactions[0].transactionHash }));
  assert.ok(validateCanary(await evidence({ transactions: duplicate }), signer.address, now).some(e => e.includes("reused")));
  const invalid = valid.transactions.map(r => ({ ...r, totalGasCostWei: "0" }));
  assert.ok(validateCanary(await evidence({ transactions: invalid }), signer.address, now).some(e => e.includes("gas")));
});
test("production deploy enforces the gate before creating any contracts", async () => {
  const source = await readFile(new URL("../../scripts/deploy-casino.ts", import.meta.url), "utf8");
  const gate = source.indexOf("execFileSync(process.execPath");
  assert.ok(gate > 0 && gate < source.indexOf("getContractFactory("));
  assert.match(source, /plankcrash-launch-gate\.ts/);
});

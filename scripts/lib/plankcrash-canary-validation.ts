import { getBytes, verifyMessage } from "ethers";
import { canonicalJson, normalizeAddresses, sha256Hex, TESTNET_CHAIN_ID } from "./testnet-canary-evidence.js";

const requiredAssertions = ["crashBeacon", "crashRouter", "crashLottery", "crashSettlesCappedPool", "lotterySource", "routerSource", "routerLottery", "routerVault", "bankAllowsCrash"];
const requiredOperations = ["beacon:setRandomness:sentinel", "crash:placeBet", "crash:lockRound", "beacon:setRandomness:round", "crash:settleRound"];
const hash = /^0x[0-9a-fA-F]{64}$/;
const address = /^0x[0-9a-fA-F]{40}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Checks evidence integrity, not independent custody or beacon fairness. */
export function validateCanary(value: unknown, expectedSigner: string, now = Date.now()): string[] {
  const errors: string[] = [];
  if (!object(value)) return ["testnet canary must be an object"];
  if (value.schema !== "plankcrash-testnet-canary/v1" || value.chainId !== TESTNET_CHAIN_ID || value.network !== "robinhood-testnet") errors.push("testnet canary schema/network is invalid");
  if (value.mode !== "fresh-stack-lifecycle") errors.push("testnet canary must exercise the complete lifecycle");
  const captured = typeof value.generatedAt === "string" ? Date.parse(value.generatedAt) : NaN;
  if (!Number.isFinite(captured) || captured > now + 60_000 || now - captured > 7 * 86_400_000) errors.push("testnet canary must be captured within seven days");
  for (const name of requiredAssertions) if (!object(value.assertions) || value.assertions[name] !== true) errors.push(`testnet assertion ${name} is missing or failed`);
  if (object(value.assertions) && Object.values(value.assertions).some(v => v !== true)) errors.push("testnet canary contains a failed assertion");
  let names: string[] = [];
  try {
    if (!object(value.addresses)) throw new Error("missing addresses");
    names = Object.keys(normalizeAddresses(value.addresses));
    for (const name of names) if (!object(value.codeHashes) || !hash.test(String(value.codeHashes[name]))) errors.push(`missing runtime hash for ${name}`);
  } catch { errors.push("testnet canary contract addresses are invalid"); }
  const seen = new Set<string>();
  for (const [field, operations] of [["transactions", requiredOperations], ["deploymentReceipts", names.map(n => `deploy:${n}`)]] as const) {
    const receipts = Array.isArray(value[field]) ? value[field] : [];
    for (const operation of operations) {
      const matches = receipts.filter(r => object(r) && r.operation === operation);
      const receipt = matches[0];
      if (matches.length !== 1 || !object(receipt) || receipt.status !== 1 || !hash.test(String(receipt.transactionHash)) || !hash.test(String(receipt.blockHash)) || !Number.isSafeInteger(receipt.blockNumber) || Number(receipt.blockNumber) <= 0) {
        errors.push(`missing or invalid receipt for ${operation}`); continue;
      }
      const tx = String(receipt.transactionHash).toLowerCase();
      if (seen.has(tx)) errors.push(`reused transaction receipt for ${operation}`);
      seen.add(tx);
      try {
        const gas = BigInt(String(receipt.gasUsed));
        const price = BigInt(String(receipt.effectiveGasPriceWei));
        if (gas <= 0n || price < 0n || gas * price !== BigInt(String(receipt.totalGasCostWei))) throw new Error();
      } catch { errors.push(`invalid gas evidence for ${operation}`); }
    }
  }
  try {
    if (!address.test(expectedSigner)) throw new Error("expected signer is missing or invalid");
    const { payloadSha256, signature, recoveredSigner, ...unsigned } = value;
    const digest = sha256Hex(canonicalJson(unsigned));
    if (payloadSha256 !== digest || typeof signature !== "string") throw new Error("payload hash mismatch");
    const recovered = verifyMessage(getBytes(digest), signature).toLowerCase();
    if (recovered !== expectedSigner.toLowerCase() || recovered !== String(value.signer).toLowerCase() || recovered !== String(recoveredSigner).toLowerCase()) throw new Error("signer mismatch");
  } catch { errors.push("testnet canary signature does not authenticate the expected signer and payload"); }
  return errors;
}

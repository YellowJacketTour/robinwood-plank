import { readFile } from "node:fs/promises";

const required = {
  PLANKCRASH_EXTERNAL_CONTRACT_AUDIT_SHA256: /^[0-9a-f]{64}$/,
  PLANKCRASH_EXTERNAL_MATH_REVIEW_SHA256: /^[0-9a-f]{64}$/,
  PLANKCRASH_LEGAL_APPROVAL_REFERENCE: /^.{8,200}$/,
  PLANKCRASH_INCIDENT_DRILL_REFERENCE: /^.{8,200}$/,
  PLANKCRASH_BUG_BOUNTY_REFERENCE: /^.{8,200}$/,
};
const blockers: string[] = [];
for (const [key, pattern] of Object.entries(required)) {
  if (!pattern.test(process.env[key]?.trim() || "")) blockers.push(`${key} is absent or malformed`);
}
const canaryPath = process.env.PLANKCRASH_TESTNET_CANARY_PATH?.trim();
if (!canaryPath) blockers.push("PLANKCRASH_TESTNET_CANARY_PATH is absent");
else {
  try {
    const canary = JSON.parse(await readFile(canaryPath, "utf8"));
    if (canary.schema !== "plankcrash.testnet-canary.v1") blockers.push("testnet canary schema is invalid");
    if (canary.chainId !== "46630") blockers.push("testnet canary was not captured on chain 46630");
    if (!canary.signedTransaction) blockers.push("testnet canary lacks a signed inclusion measurement");
    if (Object.values(canary.assertions || {}).some((value) => value !== true)) blockers.push("testnet canary contains a failed assertion");
  } catch (error) {
    blockers.push(`testnet canary is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const result = { schema: "plankcrash.mainnet-launch-gate.v1", passed: blockers.length === 0, blockers };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (blockers.length) process.exitCode = 1;


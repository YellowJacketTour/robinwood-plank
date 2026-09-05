/**
 * Signed, receipt-backed canary for the SEEDLESS Robinhood testnet stack.
 *
 * Default mode is non-invasive: verify bytecode/configuration, recover deployment
 * receipts through Blockscout, and write one harmless sentinel randomness value
 * to an unreachable mock-beacon round. Set CANARY_EXERCISE_FRESH_ROUND=1 only in
 * the same guarded job that just deployed a fresh stack; it places a minimum test
 * bet and measures the lock/reveal/settle write path.
 */
import hardhat from "hardhat";
import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { canonicalJson, normalizeAddresses, receiptGas, sha256Hex, TESTNET_CHAIN_ID } from "./lib/testnet-canary-evidence.js";

const connection = await hardhat.network.create();
if (!("ethers" in connection)) throw new Error("Hardhat ethers plugin is unavailable");
const ethers = connection.ethers as HardhatEthers;

const MANIFEST_PATH = process.env.PLANKCRASH_TESTNET_MANIFEST ?? "public/arcade/deploy-addresses.testnet.json";
const EVIDENCE_PATH = process.env.PLANKCRASH_CANARY_EVIDENCE ?? "artifacts/plankcrash-testnet-canary/evidence.json";
const EXPLORER_API = (process.env.ROBINHOOD_TESTNET_EXPLORER_API ?? "https://explorer.testnet.chain.robinhood.com/api/v2").replace(/\/$/, "");

// Keep the non-invasive canary deployable from the default branch without
// copying the unreleased canonical contract sources there. These fragments are
// the exact read/write surface exercised below; the runtime code hashes are
// independently recorded before any call is made.
const CRASH_ABI = [
  "function beacon() view returns (address)",
  "function router() view returns (address)",
  "function lottery() view returns (address)",
  "function settlementRuleId() view returns (bytes32)",
  "function settlementParamsHash() view returns (bytes32)",
  "function currentRoundId() view returns (uint256)",
  "function seatCount(uint256) view returns (uint256)",
  "function minPoolWei() view returns (uint256)",
  "function rounds(uint256) view returns (uint8 phase,uint64 targetDrandRound,uint64 bettingEndsAt,uint64 revealNotBefore,bytes32 paramsHash,uint256 seed,uint256 playerPool,uint256 reserveAtLock,uint256 largestStake,uint256 crashBps,uint256 effectiveRakeBps,uint256 playerDistributable,uint256 totalPlayerPaid,uint256 totalBonus,uint256 houseReturned,address lotteryWinner)",
  "function placeBet(uint256) payable",
  "function lockRound()",
  "function settleRound()",
];
const BANK_ABI = ["function isGame(address) view returns (bool)"];
const LOTTERY_ABI = ["function source() view returns (address)"];
const ROUTER_ABI = ["function source() view returns (address)", "function lottery() view returns (address)", "function vault() view returns (address)"];
const BEACON_ABI = [
  "function isRoundAvailable(uint64) view returns (bool)",
  "function randomnessOrZero(uint64) view returns (bytes32)",
  "function setRandomness(uint64,bytes32)",
];

type TxEvidence = ReturnType<typeof receiptGas> & {
  operation: string;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  status: number;
};

async function receiptEvidence(operation: string, hash: string): Promise<TxEvidence> {
  const receipt = await ethers.provider.getTransactionReceipt(hash);
  if (!receipt || receipt.status !== 1) throw new Error(`${operation}: missing or failed receipt ${hash}`);
  return {
    operation,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    status: receipt.status,
    ...receiptGas(receipt.gasUsed, receipt.gasPrice),
  };
}

async function creationReceipt(operation: string, address: string): Promise<TxEvidence> {
  const response = await fetch(`${EXPLORER_API}/addresses/${address}`);
  if (!response.ok) throw new Error(`${operation}: explorer lookup failed (${response.status})`);
  const body = await response.json() as { creation_transaction_hash?: string; creation_status?: string };
  if (body.creation_status !== "success" || !body.creation_transaction_hash) {
    throw new Error(`${operation}: explorer did not return a successful creation transaction`);
  }
  const evidence = await receiptEvidence(`deploy:${operation}`, body.creation_transaction_hash);
  const receipt = await ethers.provider.getTransactionReceipt(body.creation_transaction_hash);
  if (!receipt || receipt.contractAddress?.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`${operation}: creation receipt address mismatch`);
  }
  return evidence;
}

async function waitUntil(timestamp: bigint) {
  while (true) {
    const block = await ethers.provider.getBlock("latest");
    if (!block) throw new Error("Latest block unavailable");
    if (BigInt(block.timestamp) >= timestamp) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
}

async function main() {
  const network = await ethers.provider.getNetwork();
  if (Number(network.chainId) !== TESTNET_CHAIN_ID) throw new Error(`Refusing chain ${network.chainId}; expected ${TESTNET_CHAIN_ID}`);
  const manifest = JSON.parse(readFileSync(resolve(MANIFEST_PATH), "utf8")) as Record<string, unknown>;
  if (manifest.chainId !== TESTNET_CHAIN_ID || manifest.network !== "robinhood-testnet") throw new Error("Manifest is not Robinhood testnet");
  const addresses = normalizeAddresses(manifest);
  const [signer] = await ethers.getSigners();
  const signerAddress = await signer.getAddress();
  const expectedSigner = process.env.CANARY_EXPECTED_SIGNER;
  if (expectedSigner && ethers.getAddress(expectedSigner).toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error("Canary signer does not match CANARY_EXPECTED_SIGNER");
  }
  const sameKeyAsDeployer = typeof manifest.deployer === "string" && manifest.deployer.toLowerCase() === signerAddress.toLowerCase();

  const codeHashes: Record<string, string> = {};
  for (const [name, address] of Object.entries(addresses)) {
    const code = await ethers.provider.getCode(address);
    if (code === "0x") throw new Error(`${name}: no bytecode at ${address}`);
    codeHashes[name] = ethers.keccak256(code);
  }

  const crash = await ethers.getContractAt(CRASH_ABI, addresses.crash, signer);
  const bank = await ethers.getContractAt(BANK_ABI, addresses.bank, signer);
  const lottery = await ethers.getContractAt(LOTTERY_ABI, addresses.lottery, signer);
  const rakeRouter = await ethers.getContractAt(ROUTER_ABI, addresses.rakeRouter, signer);
  const beacon = await ethers.getContractAt(BEACON_ABI, addresses.beacon, signer);

  const ccs2lRuleId = ethers.keccak256(ethers.toUtf8Bytes("ccs-2l"));
  const assertions = {
    crashBeacon: (await crash.beacon()).toLowerCase() === addresses.beacon.toLowerCase(),
    crashRouter: (await crash.router()).toLowerCase() === addresses.rakeRouter.toLowerCase(),
    crashLottery: (await crash.lottery()).toLowerCase() === addresses.lottery.toLowerCase(),
    crashSettlesCcs2L: (await crash.settlementRuleId()) === ccs2lRuleId,
    lotterySource: (await lottery.source()).toLowerCase() === addresses.crash.toLowerCase(),
    routerSource: (await rakeRouter.source()).toLowerCase() === addresses.crash.toLowerCase(),
    routerLottery: (await rakeRouter.lottery()).toLowerCase() === addresses.lottery.toLowerCase(),
    routerVault: (await rakeRouter.vault()).toLowerCase() === addresses.crash.toLowerCase(),
    bankAllowsCrash: await bank.isGame(addresses.crash),
  };
  if (Object.values(assertions).some((value) => value !== true)) throw new Error("One or more deployment wiring assertions failed");

  const deploymentReceipts = await Promise.all(Object.entries(addresses).map(([name, address]) => creationReceipt(name, address)));
  const transactions: TxEvidence[] = [];

  // An unreachable uint64 sentinel proves signing, broadcast, mining, and the
  // deployed beacon write path without altering any round the game can target.
  const latest = await ethers.provider.getBlock("latest");
  if (!latest) throw new Error("Latest block unavailable");
  let sentinelRound = (1n << 64n) - 1n - (BigInt(latest.number) % 1_000_000n);
  while (await beacon.isRoundAvailable(sentinelRound)) sentinelRound -= 1n;
  const sentinelRandomness = ethers.keccak256(ethers.solidityPacked(
    ["string", "uint256", "uint256", "address", "address"],
    ["PLANKCRASH_TESTNET_CANARY_V1", network.chainId, latest.number, signerAddress, addresses.crash],
  ));
  const sentinelTx = await beacon.setRandomness(sentinelRound, sentinelRandomness);
  transactions.push(await receiptEvidence("beacon:setRandomness:sentinel", sentinelTx.hash));
  if ((await beacon.randomnessOrZero(sentinelRound)) !== sentinelRandomness) throw new Error("Sentinel randomness did not persist");

  if (process.env.CANARY_EXERCISE_FRESH_ROUND === "1") {
    const roundId = await crash.currentRoundId();
    const round = await crash.rounds(roundId);
    if (round.phase !== 0n || round.playerPool !== 0n || (await crash.seatCount(roundId)) !== 0n) {
      throw new Error("Full lifecycle canary requires a fresh, unused betting round");
    }
    const bet = await crash.placeBet(10_100n, { value: await crash.minPoolWei() });
    transactions.push(await receiptEvidence("crash:placeBet", bet.hash));
    await waitUntil(round.bettingEndsAt);
    const lock = await crash.lockRound();
    transactions.push(await receiptEvidence("crash:lockRound", lock.hash));
    const locked = await crash.rounds(roundId);
    await waitUntil(locked.revealNotBefore);
    // Arbitrary injected randomness in this openly manipulable mock: the
    // settlement is a pure function of it. Execution evidence, not fairness evidence.
    const randomTx = await beacon.setRandomness(locked.targetDrandRound, ethers.keccak256(ethers.toBeHex(1n, 32)));
    transactions.push(await receiptEvidence("beacon:setRandomness:round", randomTx.hash));
    const settle = await crash.settleRound();
    transactions.push(await receiptEvidence("crash:settleRound", settle.hash));
  }

  const unsigned = {
    schema: "plankcrash-testnet-canary/v1",
    generatedAt: new Date().toISOString(),
    network: "robinhood-testnet",
    chainId: TESTNET_CHAIN_ID,
    signer: signerAddress,
    signerRole: sameKeyAsDeployer
      ? "deployment-key-canary (same-key; not independent attestation)"
      : "separate-canary-key (control separation; independence still requires external custody evidence)",
    addresses,
    codeHashes,
    assertions,
    deploymentReceipts,
    transactions,
    mode: process.env.CANARY_EXERCISE_FRESH_ROUND === "1" ? "fresh-stack-lifecycle" : "non-invasive-sentinel",
    limitations: [
      "DrandBeaconMock randomness is permissionless and manipulable; this is execution evidence, never fairness evidence.",
      sameKeyAsDeployer
        ? "The deployment signer is reused because no separately controlled canary key is configured; this is signed provenance, not independent review."
        : "A signer distinct from the manifest deployer was used; address separation alone does not prove independent custody or independent review.",
      "Blockscout supplies creation transaction discovery; every hash, status, address, block and gas value is independently re-read from the chain RPC receipt.",
      "Testnet ETH has no represented value and no result authorizes mainnet or real-value play.",
    ],
  };
  const payload = canonicalJson(unsigned);
  const payloadSha256 = sha256Hex(payload);
  const signature = await signer.signMessage(ethers.getBytes(payloadSha256));
  const recoveredSigner = ethers.verifyMessage(ethers.getBytes(payloadSha256), signature);
  if (recoveredSigner.toLowerCase() !== signerAddress.toLowerCase()) throw new Error("Evidence signature self-check failed");
  const evidence = { ...unsigned, payloadSha256, signature, recoveredSigner };
  mkdirSync(dirname(resolve(EVIDENCE_PATH)), { recursive: true });
  writeFileSync(resolve(EVIDENCE_PATH), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`Canary PASS (${unsigned.mode}); evidence: ${EVIDENCE_PATH}; SHA-256: ${sha256Hex(JSON.stringify(evidence))}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

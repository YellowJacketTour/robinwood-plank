import { writeFile } from "node:fs/promises";
import { JsonRpcProvider, Wallet, WebSocketProvider } from "ethers";
import { assertCanaryNetwork, ROBINHOOD_TESTNET_CHAIN_ID, summarizeBlockCadence, type BlockObservation } from "../lib/plankcrash-canary";

const rpcUrl = process.env.ROBINHOOD_TESTNET_RPC_URL?.trim();
const wsUrl = process.env.ROBINHOOD_TESTNET_WS_URL?.trim();
const privateKey = process.env.PLANKCRASH_CANARY_PRIVATE_KEY?.trim();
const samples = Math.max(2, Math.min(40, Number(process.env.PLANKCRASH_CANARY_BLOCKS || 8)));
const timeoutMs = Math.max(5_000, Math.min(120_000, Number(process.env.PLANKCRASH_CANARY_TIMEOUT_MS || 60_000)));
const outputArg = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6);

if (!rpcUrl) throw new Error("ROBINHOOD_TESTNET_RPC_URL is required");

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function observeHttpBlocks(provider: JsonRpcProvider): Promise<BlockObservation[]> {
  const found: BlockObservation[] = [];
  const started = Date.now();
  let nextNumber = await provider.getBlockNumber();
  while (found.length < samples && Date.now() - started < timeoutMs) {
    const head = await provider.getBlockNumber();
    while (nextNumber <= head && found.length < samples) {
      const number = nextNumber++;
      const block = await provider.getBlock(number);
      if (!block) throw new Error(`block ${number} unavailable`);
      if (!block.hash) throw new Error(`block ${number} is pending and has no canonical hash`);
      found.push({ number, timestamp: block.timestamp, hash: block.hash, parentHash: block.parentHash, observedAtMs: Date.now() });
    }
    if (found.length < samples) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (found.length < 2) throw new Error(`insufficient block progress: observed ${found.length}`);
  return found;
}

async function observeWebSocket(): Promise<{ firstEventMs: number; blockNumber: number } | null> {
  if (!wsUrl) return null;
  const provider = new WebSocketProvider(wsUrl);
  const started = Date.now();
  try {
    const blockNumber = await withTimeout(new Promise<number>((resolve) => provider.once("block", resolve)), "WebSocket block event");
    return { firstEventMs: Date.now() - started, blockNumber };
  } finally {
    await provider.destroy();
  }
}

async function main() {
  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: false });
  const startedAt = new Date().toISOString();
  const network = await provider.getNetwork();
  const signed = Boolean(privateKey);
  assertCanaryNetwork(network.chainId, signed);
  const clientVersion = await provider.send("web3_clientVersion", []);
  const latest = await provider.getBlock("latest");
  if (!latest) throw new Error("latest block unavailable");
  const observations = await withTimeout(observeHttpBlocks(provider), "HTTP block sampling");
  const websocket = await observeWebSocket();

  let signedTransaction = null;
  if (privateKey) {
    if (network.chainId !== ROBINHOOD_TESTNET_CHAIN_ID) throw new Error("signed mode is testnet-only");
    const wallet = new Wallet(privateKey, provider);
    const before = Date.now();
    const tx = await wallet.sendTransaction({ to: wallet.address, value: 0n });
    const submittedAt = Date.now();
    const receipt = await withTimeout(tx.wait(1), "testnet receipt");
    if (!receipt || receipt.status !== 1) throw new Error("testnet self-transaction was not successful");
    signedTransaction = {
      sender: wallet.address,
      hash: tx.hash,
      blockNumber: receipt.blockNumber,
      walletToSubmissionMs: submittedAt - before,
      submissionToReceiptMs: Date.now() - submittedAt,
      confirmationsObserved: 1,
      valueWei: "0",
    };
  }

  const report = {
    schema: "plankcrash.testnet-canary.v1",
    startedAt,
    completedAt: new Date().toISOString(),
    chainId: network.chainId.toString(),
    expectedSignedChainId: ROBINHOOD_TESTNET_CHAIN_ID.toString(),
    clientVersion,
    latestAtStart: { number: latest.number, hash: latest.hash, timestamp: latest.timestamp, ageSeconds: Math.max(0, Math.floor(Date.now() / 1000) - latest.timestamp) },
    http: summarizeBlockCadence(observations),
    websocket,
    signedTransaction,
    assertions: {
      correctTestnetForSignedMode: !signed || network.chainId === ROBINHOOD_TESTNET_CHAIN_ID,
      blockNumbersMonotonic: summarizeBlockCadence(observations).monotonicNumbers,
      sampledParentContinuity: summarizeBlockCadence(observations).parentContinuity,
      latestHeadNotOlderThanFiveMinutes: Math.floor(Date.now() / 1000) - latest.timestamp < 300,
    },
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputArg) await writeFile(outputArg, serialized, { encoding: "utf8", flag: "wx" });
  process.stdout.write(serialized);
  if (Object.values(report.assertions).some((value) => !value)) process.exitCode = 1;
  await provider.destroy();
}

await main();

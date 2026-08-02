const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
const DEFAULT_VAULTS = [
  "0xc4B29D7a01603D2A5937b1FC86ea85E488d72e04",
  "0xb2019Fd4cA24502e812C0C73b751Fa49979BF708",
];
const SELECTORS = {
  collection: "0x7de1e536",
  treasury: "0x61d027b3",
  beacon: "0x59659e90",
  heldTokenCount: "0x7c99dd43",
  totalSupply: "0x18160ddd",
  ethReserve: "0xd62ccb3f",
  balanceOf: "0x70a08231",
  pendingRequester: "0x4d86c3aa",
  pendingRound: "0xcb69b3c0",
};

function vaultAddresses() {
  const raw = process.env.VAULT_ADDRESSES?.trim();
  const values = raw ? raw.split(/[\s,]+/) : DEFAULT_VAULTS;
  if (
    values.length !== 2 ||
    values.some((value) => !/^0x[a-fA-F0-9]{40}$/.test(value))
  ) {
    throw new Error("VAULT_ADDRESSES must contain exactly v2 and v1.");
  }
  return values;
}

function rpcUrl() {
  const raw = process.env.RPC_URL?.trim() || DEFAULT_RPC;
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") {
    throw new Error("RPC_URL must use HTTPS.");
  }
  return parsed.toString();
}

let requestId = 0;
async function rpc(method, params) {
  const response = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++requestId,
      method,
      params,
    }),
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`RPC ${method} failed with HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`RPC ${method} failed: ${payload.error.message || "unknown error"}.`);
  }
  if (!Object.hasOwn(payload, "result")) {
    throw new Error(`RPC ${method} returned no result.`);
  }
  return payload.result;
}

async function call(address, data) {
  const result = await rpc("eth_call", [{ to: address, data }, "latest"]);
  if (!/^0x[0-9a-fA-F]*$/.test(result) || result.length < 66) {
    throw new Error(`Invalid eth_call result for ${address}.`);
  }
  return result.slice(2);
}

function words(encoded) {
  if (encoded.length % 64 !== 0) throw new Error("Invalid ABI response length.");
  return encoded.match(/.{64}/g) || [];
}

function addressWord(word) {
  return `0x${word.slice(24)}`;
}

function uintWord(word) {
  return BigInt(`0x${word}`).toString();
}

function addressArgument(address) {
  return address.slice(2).toLowerCase().padStart(64, "0");
}

async function readVault(address) {
  const results = await Promise.all([
    call(address, SELECTORS.collection),
    call(address, SELECTORS.treasury),
    call(address, SELECTORS.beacon),
    call(address, SELECTORS.heldTokenCount),
    call(address, SELECTORS.totalSupply),
    call(address, SELECTORS.ethReserve),
    call(address, `${SELECTORS.balanceOf}${addressArgument(address)}`),
    call(address, SELECTORS.pendingRequester),
    call(address, SELECTORS.pendingRound),
  ]);
  const pending = words(results[8]);
  if (pending.length < 2) throw new Error(`Invalid pendingRound result for ${address}.`);
  return {
    address,
    collection: addressWord(words(results[0])[0]),
    treasury: addressWord(words(results[1])[0]),
    beacon: addressWord(words(results[2])[0]),
    held: uintWord(words(results[3])[0]),
    totalSupply: uintWord(words(results[4])[0]),
    ethReserve: uintWord(words(results[5])[0]),
    shareReserve: uintWord(words(results[6])[0]),
    pendingRequester: addressWord(words(results[7])[0]),
    pendingRound: uintWord(pending[0]),
    pendingRoundAvailable: BigInt(`0x${pending[1]}`) !== 0n,
  };
}

async function main() {
  const [chainId, blockNumber, vaults] = await Promise.all([
    rpc("eth_chainId", []),
    rpc("eth_blockNumber", []),
    Promise.all(vaultAddresses().map(readVault)),
  ]);
  console.log(
    `VAULT_STATE=${JSON.stringify({
      chainId: BigInt(chainId).toString(),
      blockNumber: Number(BigInt(blockNumber)),
      vaults,
    })}`
  );
}

main().catch((error) => {
  console.error(`[vault-state] ${error.message}`);
  process.exitCode = 1;
});

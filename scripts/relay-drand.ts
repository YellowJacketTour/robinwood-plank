/**
 * Permissionless drand relay and random-redemption settlement for both vaults.
 *
 * The signer must be a dedicated gas-only wallet. It has no vault privilege:
 * DrandBeacon verifies every signature on-chain and all settlement methods are
 * permissionless.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  Contract,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  type TransactionReceipt,
  type TransactionResponse,
} from "ethers";

const BEACON_ABI = [
  "function submitRound(uint64 round, uint256[2] signature)",
  "function isRoundAvailable(uint64 round) view returns (bool)",
  "function currentRoundAt(uint256 timestamp) view returns (uint64)",
  "function period() view returns (uint256)",
];
const VAULT_ABI = [
  "function pendingRequester() view returns (address)",
  "function pendingRound() view returns (uint64 round, bool available)",
  "function pinPendingDraw()",
  "function claimRandomRedeemFor(address requester) returns (uint256 tokenId)",
  "function forfeitExpiredRedeem(address requester)",
];
const ROUND_EXPIRY = BigInt(28_800);

export type DrandRound = {
  round: number;
  signature: string;
  randomness?: string;
};
export type VaultState =
  | "idle"
  | "waiting"
  | "settled"
  | "forfeited"
  | "error";
export type VaultResult = {
  vault: string;
  state: VaultState;
  actionable: boolean;
  requester?: string;
  round?: string;
  detail?: string;
};
export type VaultRelayPort = {
  pendingRequester(): Promise<string>;
  pendingRound(): Promise<{ round: bigint; available: boolean }>;
  latestDrandRound(): Promise<bigint>;
  relayExactRound(round: bigint): Promise<void>;
  isRoundAvailable(round: bigint): Promise<boolean>;
  currentDrandRound(): Promise<bigint>;
  pin(requester: string): Promise<void>;
  claim(requester: string): Promise<void>;
  forfeit(requester: string): Promise<void>;
};

export class DrandRoundUnavailableError extends Error {
  constructor(round: bigint | string) {
    super(`drand round ${round.toString()} is not published`);
    this.name = "DrandRoundUnavailableError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export function parseG1(hex: string): [bigint, bigint] {
  const value = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{128}$/.test(value)) {
    throw new Error(
      `Expected an uncompressed 64-byte G1 signature; got ${value.length} hex characters.`
    );
  }
  return [
    BigInt(`0x${value.slice(0, 64)}`),
    BigInt(`0x${value.slice(64)}`),
  ];
}

export async function fetchRound(
  api: string,
  chainHash: string,
  round: bigint | "latest"
): Promise<DrandRound> {
  const url = `${api.replace(/\/$/, "")}/${chainHash}/public/${round.toString()}`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) {
    throw new DrandRoundUnavailableError(round);
  }
  if (!response.ok) {
    throw new Error(`drand API returned HTTP ${response.status}`);
  }
  const value = (await response.json()) as DrandRound;
  if (
    !Number.isSafeInteger(value.round) ||
    value.round <= 0 ||
    typeof value.signature !== "string"
  ) {
    throw new Error("drand API returned an invalid round payload");
  }
  return value;
}

/** Require independent transports to agree before spending relay gas. The
 * on-chain BLS verifier remains authoritative; this quorum removes a single
 * HTTP origin as a liveness or equivocation dependency. */
export async function fetchRoundFromApis(
  apis: readonly string[],
  chainHash: string,
  round: bigint | "latest"
): Promise<DrandRound> {
  const unique = [...new Set(apis.map((api) => api.trim().replace(/\/$/, "")).filter(Boolean))];
  if (unique.length < 2) throw new Error("DRAND_APIS must contain at least two distinct relay origins");
  const settled = await Promise.allSettled(unique.map((api) => fetchRound(api, chainHash, round)));
  const values = settled
    .filter((item): item is PromiseFulfilledResult<DrandRound> => item.status === "fulfilled")
    .map((item) => item.value);
  if (values.length < 2) throw new Error("fewer than two independent drand relays responded");
  if (round === "latest") return values.reduce((best, value) => value.round > best.round ? value : best);

  const expected = round.toString();
  const counts = new Map<string, { count: number; value: DrandRound }>();
  for (const value of values) {
    if (BigInt(value.round).toString() !== expected) continue;
    const key = `${value.round}:${value.signature.toLowerCase()}`;
    const prior = counts.get(key);
    counts.set(key, { count: (prior?.count ?? 0) + 1, value });
  }
  const agreed = [...counts.values()].find((entry) => entry.count >= 2);
  if (!agreed) throw new Error(`drand relays did not reach 2-origin agreement for round ${expected}`);
  return agreed.value;
}

function result(
  vault: string,
  state: VaultState,
  actionable: boolean,
  fields: Omit<VaultResult, "vault" | "state" | "actionable"> = {}
): VaultResult {
  return { vault, state, actionable, ...fields };
}

async function confirmCleared(
  port: VaultRelayPort,
  vault: string,
  successState: "settled" | "forfeited",
  requester: string,
  round: bigint
): Promise<VaultResult> {
  const remaining = await port.pendingRequester();
  if (remaining.toLowerCase() === ZeroAddress.toLowerCase()) {
    return result(vault, successState, false, {
      requester,
      round: round.toString(),
    });
  }
  const detail =
    remaining.toLowerCase() === requester.toLowerCase()
      ? "occupied redemption slot remained after confirmed transaction"
      : `a replacement request is already pending for ${remaining}`;
  return result(vault, "error", true, {
    requester: remaining,
    round: round.toString(),
    detail,
  });
}

async function racedOrError(
  port: VaultRelayPort,
  vault: string,
  requester: string,
  round: bigint,
  action: string,
  error: unknown
): Promise<VaultResult> {
  try {
    const remaining = await port.pendingRequester();
    if (remaining.toLowerCase() === ZeroAddress.toLowerCase()) {
      return result(vault, "settled", false, {
        requester,
        round: round.toString(),
        detail: `${action} lost an idempotent race; slot was cleared by another relayer`,
      });
    }
  } catch {
    // Preserve the original actionable error below.
  }
  return result(vault, "error", true, {
    requester,
    round: round.toString(),
    detail: `${action} failed: ${errorMessage(error)}`,
  });
}

export async function settleVault(
  vault: string,
  port: VaultRelayPort
): Promise<VaultResult> {
  let requester: string;
  let pending: { round: bigint; available: boolean };
  try {
    requester = await port.pendingRequester();
    if (!requester || requester.toLowerCase() === ZeroAddress.toLowerCase()) {
      return result(vault, "idle", false);
    }
    pending = await port.pendingRound();
  } catch (error) {
    return result(vault, "error", true, {
      detail: `vault state read failed: ${errorMessage(error)}`,
    });
  }

  const round = pending.round;
  const fields = { requester, round: round.toString() };
  if (round <= BigInt(0)) {
    return result(vault, "error", true, {
      ...fields,
      detail: "pending requester has no target drand round",
    });
  }

  if (!pending.available) {
    let latest: bigint;
    try {
      latest = await port.latestDrandRound();
    } catch (error) {
      return result(vault, "error", true, {
        ...fields,
        detail: `latest drand round read failed: ${errorMessage(error)}`,
      });
    }
    if (round > latest) {
      return result(vault, "waiting", false, {
        ...fields,
        detail: `latest published drand round is ${latest.toString()}`,
      });
    }

    try {
      await port.relayExactRound(round);
    } catch (error) {
      if (error instanceof DrandRoundUnavailableError) {
        const current = await port.currentDrandRound();
        if (current > round && current - round > ROUND_EXPIRY) {
          try {
            await port.forfeit(requester);
            return await confirmCleared(
              port,
              vault,
              "forfeited",
              requester,
              round
            );
          } catch (forfeitError) {
            return await racedOrError(
              port,
              vault,
              requester,
              round,
              "forfeit",
              forfeitError
            );
          }
        }
      }
      return await racedOrError(
        port,
        vault,
        requester,
        round,
        "exact-round relay",
        error
      );
    }

    try {
      if (!(await port.isRoundAvailable(round))) {
        return result(vault, "error", true, {
          ...fields,
          detail: "exact round submission confirmed but the beacon still reports unavailable",
        });
      }
    } catch (error) {
      return result(vault, "error", true, {
        ...fields,
        detail: `round confirmation failed: ${errorMessage(error)}`,
      });
    }
  }

  try {
    await port.pin(requester);
  } catch (error) {
    return await racedOrError(port, vault, requester, round, "pin", error);
  }
  try {
    await port.claim(requester);
  } catch (error) {
    return await racedOrError(port, vault, requester, round, "claim", error);
  }
  return await confirmCleared(port, vault, "settled", requester, round);
}

function parseVaultAddresses(): string[] {
  const raw = process.env.VAULT_ADDRESSES || "";
  const values = raw
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error("VAULT_ADDRESSES must contain at least one address");
  }
  if (values.some((value) => !/^0x[a-fA-F0-9]{40}$/.test(value))) {
    throw new Error("VAULT_ADDRESSES contains an invalid address");
  }
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

async function waitFor(tx: TransactionResponse, action: string): Promise<void> {
  console.log(`${action} submitted tx=${tx.hash}`);
  const receipt = (await tx.wait()) as TransactionReceipt | null;
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${action} transaction did not succeed`);
  }
  console.log(`${action} confirmed tx=${tx.hash} block=${receipt.blockNumber}`);
}

async function main(): Promise<void> {
  const provider = new JsonRpcProvider(required("RPC_URL"));
  const wallet = new Wallet(required("RELAYER_PRIVATE_KEY"), provider);
  const beacon = new Contract(required("BEACON_ADDRESS"), BEACON_ABI, wallet);
  const apis = (process.env.DRAND_APIS || process.env.DRAND_API ||
    "https://api.drand.sh,https://api2.drand.sh,https://drand.cloudflare.com")
    .split(/[\s,]+/).filter(Boolean);
  const chainHash = required("DRAND_CHAIN_HASH").replace(/^0x/, "");
  const vaults = parseVaultAddresses();

  const balance = await provider.getBalance(wallet.address);
  console.log(
    `RELAYER_GAS=${JSON.stringify({
      timestamp: new Date().toISOString(),
      address: wallet.address,
      balanceWei: balance.toString(),
      low: balance < BigInt("100000000000000"),
    })}`
  );

  const relayExactRound = async (round: bigint): Promise<void> => {
    if (await beacon.isRoundAvailable(round)) return;
    const data = await fetchRoundFromApis(apis, chainHash, round);
    if (BigInt(data.round) !== round) {
      throw new Error(
        `drand returned round ${data.round} when ${round.toString()} was requested`
      );
    }
    await waitFor(
      await beacon.submitRound(round, parseG1(data.signature)),
      `beacon.submitRound(${round.toString()})`
    );
  };

  if (process.env.ROUND) {
    const manualRound = BigInt(process.env.ROUND);
    await relayExactRound(manualRound);
    if (!(await beacon.isRoundAvailable(manualRound))) {
      throw new Error(`manual round ${manualRound.toString()} did not confirm`);
    }
  }

  if (vaults.length === 0) {
    if (!process.env.ROUND) {
      const latest = await fetchRoundFromApis(apis, chainHash, "latest");
      await relayExactRound(BigInt(latest.round));
    }
    return;
  }

  const tick = async (): Promise<void> => {
    const statuses: VaultResult[] = [];
    for (const address of vaults) {
      const vault = new Contract(address, VAULT_ABI, wallet);
      const port: VaultRelayPort = {
        pendingRequester: async () => (await vault.pendingRequester()) as string,
        pendingRound: async () => {
          const pending = await vault.pendingRound();
          return { round: BigInt(pending[0]), available: Boolean(pending[1]) };
        },
        latestDrandRound: async () =>
          BigInt((await fetchRoundFromApis(apis, chainHash, "latest")).round),
        relayExactRound,
        isRoundAvailable: async (round) =>
          Boolean(await beacon.isRoundAvailable(round)),
        currentDrandRound: async () => {
          const block = await provider.getBlock("latest");
          if (!block) throw new Error("latest block was unavailable");
          return BigInt(await beacon.currentRoundAt(block.timestamp));
        },
        pin: async (requester) =>
          waitFor(await vault.pinPendingDraw(), `vault ${address} pin ${requester}`),
        claim: async (requester) =>
          waitFor(
            await vault.claimRandomRedeemFor(requester),
            `vault ${address} claim ${requester}`
          ),
        forfeit: async (requester) =>
          waitFor(
            await vault.forfeitExpiredRedeem(requester),
            `vault ${address} forfeit ${requester}`
          ),
      };
      statuses.push(await settleVault(address, port));
    }
    console.log(
      `RELAYER_STATUS=${JSON.stringify({
        timestamp: new Date().toISOString(),
        vaults: statuses,
      })}`
    );
    if (statuses.some((status) => status.state === "error")) {
      throw new Error("one or more vaults retain an actionable or unreadable slot");
    }
  };

  if (process.env.WATCH !== "1") {
    await tick();
    return;
  }
  const periodMs = Number(await beacon.period()) * 1_000;
  for (;;) {
    try {
      await tick();
    } catch (error) {
      console.error(`RELAYER_ERROR=${JSON.stringify({ detail: errorMessage(error) })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, periodMs));
  }
}

let invokedDirectly = false;
try {
  invokedDirectly =
    Boolean(process.argv[1]) &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  invokedDirectly = false;
}
if (invokedDirectly) {
  main().catch((error) => {
    console.error(
      `RELAYER_FATAL=${JSON.stringify({
        timestamp: new Date().toISOString(),
        detail: errorMessage(error),
      })}`
    );
    process.exitCode = 1;
  });
}

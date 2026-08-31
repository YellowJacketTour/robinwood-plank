import { createHash } from "node:crypto";
import { getAddress, isAddress } from "ethers";

export const TESTNET_CHAIN_ID = 46630;

export type CanaryAddresses = {
  crash: string;
  bank: string;
  fuelBooster: string;
  progression: string;
  powerboard: string;
  beacon: string;
};

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function sha256Hex(value: string | Uint8Array): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

export function normalizeAddresses(input: Record<string, unknown>): CanaryAddresses {
  const required = ["crash", "bank", "fuelBooster", "progression", "powerboard", "beacon"] as const;
  const normalized = {} as CanaryAddresses;
  for (const key of required) {
    const value = input[key];
    if (typeof value !== "string" || !isAddress(value)) throw new Error(`Invalid or missing ${key} address`);
    normalized[key] = getAddress(value);
  }
  if (new Set(Object.values(normalized).map((value) => value.toLowerCase())).size !== required.length) {
    throw new Error("Canary contract addresses must be distinct");
  }
  return normalized;
}

export function receiptGas(gasUsed: bigint, effectiveGasPrice: bigint) {
  return {
    gasUsed: gasUsed.toString(),
    effectiveGasPriceWei: effectiveGasPrice.toString(),
    totalGasCostWei: (gasUsed * effectiveGasPrice).toString(),
  };
}

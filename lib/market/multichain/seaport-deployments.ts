/** Canonical cross-chain Seaport deployments published by OpenSea. */
export const SEAPORT_DEPLOYMENTS = [
  { version: "1.1", address: "0x00000000006c3852cbEf3e08E8dF289169EdE581" },
  { version: "1.2", address: "0x00000000000006c7676171937C444f6BDe3D6282" },
  { version: "1.3", address: "0x0000000000000aD24e80fd803C6ac37206a45f15" },
  { version: "1.4", address: "0x00000000000001ad428e4906aE43D8F9852d0dD6" },
  { version: "1.5", address: "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC" },
  { version: "1.6", address: "0x0000000000000068F116a894984e2DB1123eB395" },
] as const;

export const ALL_SEAPORT_ADDRESSES = SEAPORT_DEPLOYMENTS.map((deployment) => deployment.address);

export function seaportVersionForAddress(address: string): string | null {
  return SEAPORT_DEPLOYMENTS.find((deployment) =>
    deployment.address.toLowerCase() === address.toLowerCase())?.version ?? null;
}

export type Hex = `0x${string}`;

export function asHex(value: string): Hex {
  const v = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]*$/.test(v) || v.length % 2 !== 0) {
    throw new Error(`invalid hex: ${value}`);
  }
  return v.toLowerCase() as Hex;
}

export function strip0x(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

export function pad32(hex: string): Hex {
  const s = strip0x(hex).toLowerCase();
  return asHex(s.padStart(64, "0"));
}

export function bytesEq(a: string, b: string): boolean {
  return strip0x(a).toLowerCase() === strip0x(b).toLowerCase();
}

const HEX_32 = /^[0-9a-f]{64}$/;
const SAMPLE_SPACE = 1n << 256n;
const UNBIASED_LIMIT = SAMPLE_SPACE - (SAMPLE_SPACE % 10_000n);

function bytesFromHex(hex) {
  if (!HEX_32.test(hex)) throw new RangeError("Expected a lowercase 32-byte hex value.");
  return Uint8Array.from(hex.match(/../g), (byte) => Number.parseInt(byte, 16));
}

function hexFromBytes(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(hex) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytesFromHex(hex));
  return hexFromBytes(new Uint8Array(digest));
}

export async function privateCrashBpsFromReveal(revealHex) {
  if (!HEX_32.test(revealHex)) throw new RangeError("Invalid private-round reveal.");
  let digest = revealHex;
  let sample = BigInt(`0x${digest}`);
  while (sample >= UNBIASED_LIMIT) {
    digest = await sha256Hex(digest);
    sample = BigInt(`0x${digest}`);
  }
  const bucket = sample % 10_000n;
  return bucket === 0n ? 10_000n : 100_000_000n / (10_000n - bucket);
}

export async function verifyPrivateRound({ commitment, reveal, crashBps }) {
  if (!HEX_32.test(commitment) || !HEX_32.test(reveal) || !/^\d+$/.test(String(crashBps))) {
    return { verified: false, commitmentMatches: false, crashMatches: false, derivedCrashBps: null };
  }
  const [derivedCommitment, derivedCrashBps] = await Promise.all([
    sha256Hex(reveal),
    privateCrashBpsFromReveal(reveal),
  ]);
  const commitmentMatches = derivedCommitment === commitment;
  const crashMatches = derivedCrashBps === BigInt(crashBps);
  return { verified: commitmentMatches && crashMatches, commitmentMatches, crashMatches, derivedCrashBps };
}

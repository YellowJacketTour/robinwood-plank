/**
 * An INDEPENDENT TypeScript implementation of the same BN254 hash-to-curve and
 * BLS scheme that contracts/lib/BLSBN254.sol implements, written directly from
 * RFC 9380 (§5.3.1 expand_message_xmd, Appendix F.1 Shallue-van de Woestijne).
 *
 * It is deliberately NOT a port of the Solidity — it is written from the spec
 * so that agreement between the two is evidence, not tautology. Curve
 * arithmetic (scalar multiplication, pairing) comes from @noble/curves' bn254,
 * an independent third-party implementation, so the signatures this produces
 * are real BLS signatures verifiable without any of our own code.
 */
import { keccak256, solidityPacked, getBytes, concat, hexlify } from "ethers";
// @noble/curves 1.9.x is the copy that carries full BN254 pairing support.
import { bn254 } from "../../../node_modules/viem/node_modules/@noble/curves/bn254.js";

export const P =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;
export const R = bn254.params.r as bigint;

/**
 * The DST for drand's BN254 EVM beacon. PLACEHOLDER-GRADE: it matches the
 * scheme name used by the BN254 drand scheme, but it could not be confirmed
 * against the live network from this sandbox. It is a constructor argument on
 * DrandBeacon precisely so it can be corrected without touching code.
 */
export const DRAND_BN254_DOMAIN = "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_";

function mod(a: bigint, m: bigint = P): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}
function pw(b: bigint, e: bigint, m: bigint = P): bigint {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
const inv0 = (a: bigint) => (a === 0n ? 0n : pw(a, P - 2n));
const sqrtF = (a: bigint) => pw(a, (P + 1n) / 4n);
const isSquare = (a: bigint) => a === 0n || pw(a, (P - 1n) / 2n) === 1n;

// RFC 9380 Appendix F.1 constants for A=0, B=3, Z=1 — derived here, not copied.
const G_Z = 4n; // Z^3 + 3
export const C1 = G_Z;
export const C2 = (P - 1n) / 2n; // -Z/2
export const C3 = (() => {
  let c = sqrtF(mod(-G_Z * 3n)); // sqrt(-g(Z) * 3Z^2)
  if (c % 2n === 1n) c = P - c; // sgn0(c3) == 0
  return c;
})();
export const C4 = mod(mod(-4n * G_Z) * inv0(3n)); // -4g(Z) / 3Z^2

export const Z_PAD_LEN = 136; // keccak256 input block size (sponge rate)

/** RFC 9380 §5.3.1 expand_message_xmd with H = keccak256, len_in_bytes = 96. */
export function expandMsgTo96(domain: string, message: Uint8Array): Uint8Array {
  const dst = new TextEncoder().encode(domain);
  if (dst.length > 255) throw new Error("DST too long");
  const dstPrime = concat([dst, new Uint8Array([dst.length])]);
  const zPad = new Uint8Array(Z_PAD_LEN);
  const lenBytes = new Uint8Array([0, 96]); // I2OSP(96, 2)

  const b0 = getBytes(
    keccak256(concat([zPad, message, lenBytes, new Uint8Array([0]), dstPrime]))
  );
  const bs: Uint8Array[] = [];
  let prev = b0;
  for (let i = 1; i <= 3; i++) {
    const xored =
      i === 1 ? b0 : Uint8Array.from(b0.map((v, j) => v ^ prev[j]));
    const bi = getBytes(keccak256(concat([xored, new Uint8Array([i]), dstPrime])));
    bs.push(bi);
    prev = bi;
  }
  return getBytes(concat(bs));
}

/** RFC 9380 §5.2 hash_to_field, count = 2, m = 1, L = 48. */
export function hashToField(domain: string, message: Uint8Array): [bigint, bigint] {
  const expanded = expandMsgTo96(domain, message);
  const out: bigint[] = [];
  for (let i = 0; i < 2; i++) {
    const chunk = expanded.slice(i * 48, i * 48 + 48);
    out.push(mod(BigInt(hexlify(chunk))));
  }
  return [out[0], out[1]];
}

/** RFC 9380 Appendix F.1 straight-line SvdW, A = 0, B = 3, Z = 1. */
export function mapToPoint(u: bigint): { x: bigint; y: bigint } {
  u = mod(u);
  let tv1 = mod(mod(u * u) * C1);
  const tv2 = mod(1n + tv1);
  tv1 = mod(1n - tv1);
  const tv3 = inv0(mod(tv1 * tv2));
  const tv4 = mod(mod(mod(u * tv1) * tv3) * C3);

  const x1 = mod(C2 - tv4);
  const gx1 = mod(mod(mod(x1 * x1) * x1) + 3n);
  const e1 = isSquare(gx1);

  const x2 = mod(C2 + tv4);
  const gx2 = mod(mod(mod(x2 * x2) * x2) + 3n);
  const e2 = isSquare(gx2) && !e1;

  let x3 = mod(tv2 * tv2);
  x3 = mod(x3 * tv3);
  x3 = mod(x3 * x3);
  x3 = mod(x3 * C4);
  x3 = mod(x3 + 1n);

  const x = e1 ? x1 : e2 ? x2 : x3;
  const gx = mod(mod(mod(x * x) * x) + 3n);
  let y = sqrtF(gx);
  if ((u & 1n) !== (y & 1n)) y = mod(-y);
  return { x, y };
}

export type G1 = { x: bigint; y: bigint };

/** hash_to_curve: two field elements, two SvdW maps, one curve addition. */
export function hashToPoint(domain: string, message: Uint8Array): G1 {
  const [u0, u1] = hashToField(domain, message);
  const a = mapToPoint(u0);
  const b = mapToPoint(u1);
  const pa = new bn254.G1.ProjectivePoint(a.x, a.y, 1n);
  const pb = new bn254.G1.ProjectivePoint(b.x, b.y, 1n);
  pa.assertValidity();
  pb.assertValidity();
  const sum = pa.add(pb).toAffine();
  return { x: sum.x, y: sum.y };
}

/** The message preimage DrandBeacon.messagePoint uses: keccak256(uint64 round). */
export function roundMessage(round: bigint | number): Uint8Array {
  return getBytes(keccak256(solidityPacked(["uint64"], [round])));
}

/** Public key (G2) for a secret scalar, in EIP-197 [x_i, x_r, y_i, y_r] order. */
export function publicKeyG2(sk: bigint): [bigint, bigint, bigint, bigint] {
  const pk = bn254.G2.ProjectivePoint.BASE.multiply(mod(sk, R)).toAffine();
  return [pk.x.c1, pk.x.c0, pk.y.c1, pk.y.c0];
}

/** Sign a drand-style round: sig = sk * H(keccak256(round)). */
export function signRound(sk: bigint, round: bigint | number, domain = DRAND_BN254_DOMAIN): [bigint, bigint] {
  const h = hashToPoint(domain, roundMessage(round));
  const hp = new bn254.G1.ProjectivePoint(h.x, h.y, 1n);
  const sig = hp.multiply(mod(sk, R)).toAffine();
  return [sig.x, sig.y];
}

/**
 * Independent (non-Solidity, non-ours-beyond-hashing) verification, using
 * noble's pairing: e(sig, G2) == e(H(m), pk).
 */
export function verifyOffChain(
  sig: [bigint, bigint],
  pk: [bigint, bigint, bigint, bigint],
  round: bigint | number,
  domain = DRAND_BN254_DOMAIN
): boolean {
  const h = hashToPoint(domain, roundMessage(round));
  const sigP = new bn254.G1.ProjectivePoint(sig[0], sig[1], 1n);
  const hP = new bn254.G1.ProjectivePoint(h.x, h.y, 1n);
  const pkP = new bn254.G2.ProjectivePoint(
    bn254.fields.Fp2.create({ c0: pk[1], c1: pk[0] }),
    bn254.fields.Fp2.create({ c0: pk[3], c1: pk[2] }),
    bn254.fields.Fp2.ONE
  );
  const lhs = bn254.pairing(sigP, bn254.G2.ProjectivePoint.BASE);
  const rhs = bn254.pairing(hP, pkP);
  return bn254.fields.Fp12.eql(lhs, rhs);
}

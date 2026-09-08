/**
 * Ordinals envelope parser: inscriptions from raw tapscript witness.
 *
 * WHY THIS FILE IS THE POINT OF THE WHOLE BITCOIN ADAPTER
 * ------------------------------------------------------
 * Measured on production 2026-09-08: OrdinalsWallet's catalog reports
 * `total: 425,201`, but real non-BRC-20 collections number ~1,837 (density
 * per 500 at offsets 0/500/1000/1500 is 499/490/483/363, then 2 at offset
 * 2000). We already hold 19,601 from other sources. Every alternative was
 * closed when tested: Ordiscan `402 Payment Required`, Magic Eden `503`,
 * UniSat `404` without a key.
 *
 * So Bitcoin existence cannot come from a publisher's list without hitting
 * a ceiling that is somebody else's business decision. It has to come from
 * the chain. An inscription IS its reveal witness; parsing that witness is
 * the only path to "every inscription that exists" that no vendor can
 * revoke, paywall, or 410.
 *
 * THE FORMAT (ord protocol, docs.ordinals.com / github.com/ordinals/ord)
 * ---------------------------------------------------------------------
 * An inscription is a taproot script-path spend whose witness script holds:
 *
 *   OP_FALSE OP_IF
 *     OP_PUSH "ord"
 *     [ OP_PUSH <tag> OP_PUSH <value> ]...   -- tagged fields
 *     OP_PUSH 0                              -- body separator (empty push)
 *     [ OP_PUSH <chunk> ]...                 -- body, possibly many chunks
 *   OP_ENDIF
 *
 * Tags we decode: 1 = content_type, 3 = parent, 5 = metadata, 9 = content
 * encoding. Tag 3 (parent) is the ONLY provenance field here that becomes a
 * HARD edge in the announcement graph -- everything else is a candidate at
 * most. That distinction is load-bearing: a soft edge promoted to hard is
 * how two unrelated projects get merged forever.
 */
import type { Hex } from "../../shared/hex.ts";

export interface Inscription {
  /** `<reveal_txid>i<index>` -- the canonical ordinals id. */
  id: string;
  revealTxid: string;
  index: number;
  contentType: string | null;
  /** Inscription id of the declared parent (tag 3), if any. HARD edge. */
  parent: string | null;
  bodySha256: Hex | null;
  bodyLength: number;
  /** Position within the input's witness stack, for provenance. */
  inputIndex: number;
}

const OP_FALSE = 0x00;
const OP_IF = 0x63;
const OP_ENDIF = 0x68;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;
const OP_1NEGATE = 0x4f;
const OP_1 = 0x51;
const OP_16 = 0x60;

const TAG_CONTENT_TYPE = 1;
const TAG_PARENT = 3;

/** One push operation read off a script, or null at end/parse failure. */
interface Push {
  data: Uint8Array;
  next: number;
  /** True for OP_1..OP_16 and OP_1NEGATE, which encode small ints, not data. */
  isSmallInt: boolean;
  smallInt?: number;
}

function byteAt(script: Uint8Array, i: number): number | null {
  return i >= 0 && i < script.length ? (script[i] as number) : null;
}

function readPush(script: Uint8Array, i: number): Push | null {
  const op = byteAt(script, i);
  if (op === null) return null;

  // Direct push: the opcode IS the length (1..75).
  if (op > 0 && op < OP_PUSHDATA1) {
    const end = i + 1 + op;
    if (end > script.length) return null;
    return { data: script.slice(i + 1, end), next: end, isSmallInt: false };
  }
  if (op === OP_PUSHDATA1) {
    const len = byteAt(script, i + 1);
    if (len === null) return null;
    const end = i + 2 + len;
    if (end > script.length) return null;
    return { data: script.slice(i + 2, end), next: end, isSmallInt: false };
  }
  if (op === OP_PUSHDATA2) {
    const b1 = byteAt(script, i + 1);
    const b2 = byteAt(script, i + 2);
    if (b1 === null || b2 === null) return null;
    const len = b1 | (b2 << 8);
    const end = i + 3 + len;
    if (end > script.length) return null;
    return { data: script.slice(i + 3, end), next: end, isSmallInt: false };
  }
  if (op === OP_PUSHDATA4) {
    const b1 = byteAt(script, i + 1);
    const b2 = byteAt(script, i + 2);
    const b3 = byteAt(script, i + 3);
    const b4 = byteAt(script, i + 4);
    if (b1 === null || b2 === null || b3 === null || b4 === null) return null;
    const len = (b1 | (b2 << 8) | (b3 << 16) | (b4 << 24)) >>> 0;
    const end = i + 5 + len;
    // A 4-byte length is a decompression-bomb vector; refuse absurd sizes.
    if (len > 8_000_000 || end > script.length) return null;
    return { data: script.slice(i + 5, end), next: end, isSmallInt: false };
  }
  // Empty push: OP_FALSE in data position is the body separator.
  if (op === OP_FALSE) {
    return { data: new Uint8Array(0), next: i + 1, isSmallInt: false };
  }
  // Small integers: tags are encoded this way (OP_1 => 1, etc).
  if (op >= OP_1 && op <= OP_16) {
    return { data: new Uint8Array(0), next: i + 1, isSmallInt: true, smallInt: op - OP_1 + 1 };
  }
  if (op === OP_1NEGATE) {
    return { data: new Uint8Array(0), next: i + 1, isSmallInt: true, smallInt: -1 };
  }
  return null;
}

const ORD = new Uint8Array([0x6f, 0x72, 0x64]); // "ord"

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Tag value as a number: ord encodes small tags as OP_N, larger as a push. */
function tagValue(p: Push): number | null {
  if (p.isSmallInt) return p.smallInt ?? null;
  if (p.data.length === 0) return 0;
  if (p.data.length === 1) return p.data[0] as number;
  return null;
}

/** Parent field is a 32-byte txid (little-endian) + optional varint index. */
function decodeParent(data: Uint8Array): string | null {
  if (data.length < 32 || data.length > 36) return null;
  const txidLe = data.slice(0, 32);
  let hex = "";
  for (let i = txidLe.length - 1; i >= 0; i--) hex += (txidLe[i] as number).toString(16).padStart(2, "0");
  let index = 0;
  for (let i = 32; i < data.length; i++) index |= (data[i] as number) << ((i - 32) * 8);
  return `${hex}i${index}`;
}

/**
 * Parse every inscription envelope in one tapscript.
 *
 * A single script may contain MULTIPLE envelopes (batch reveals), which is
 * exactly the `SAME_REVEAL` hard edge the cluster graph relies on -- so this
 * returns all of them with their order preserved, never just the first.
 */
export function parseEnvelopes(
  script: Uint8Array,
  ctx: { revealTxid: string; inputIndex: number; startIndex?: number },
  sha256: (b: Uint8Array) => Hex
): Inscription[] {
  const out: Inscription[] = [];
  let i = 0;
  let index = ctx.startIndex ?? 0;

  while (i < script.length) {
    // Envelopes begin with the exact sequence OP_FALSE OP_IF.
    if (byteAt(script, i) !== OP_FALSE || byteAt(script, i + 1) !== OP_IF) {
      i++;
      continue;
    }
    let j = i + 2;

    const proto = readPush(script, j);
    if (!proto || !bytesEqual(proto.data, ORD)) {
      i++;
      continue;
    }
    j = proto.next;

    let contentType: string | null = null;
    let parent: string | null = null;
    const bodyChunks: Uint8Array[] = [];
    let inBody = false;
    let closed = false;

    while (j < script.length) {
      if (byteAt(script, j) === OP_ENDIF) {
        closed = true;
        j++;
        break;
      }
      const p = readPush(script, j);
      if (!p) break;
      j = p.next;

      if (inBody) {
        if (p.data.length > 0) bodyChunks.push(p.data);
        continue;
      }
      // An empty push ends the field section and starts the body.
      if (!p.isSmallInt && p.data.length === 0) {
        inBody = true;
        continue;
      }
      const tag = tagValue(p);
      const val = readPush(script, j);
      if (!val) break;
      j = val.next;
      if (tag === TAG_CONTENT_TYPE) {
        contentType = new TextDecoder().decode(val.data) || null;
      } else if (tag === TAG_PARENT) {
        parent = decodeParent(val.data);
      }
      // Other tags are recorded by the caller from `raw` if needed; they are
      // never identity here.
    }

    if (closed) {
      let bodyLength = 0;
      for (const c of bodyChunks) bodyLength += c.length;
      let bodySha: Hex | null = null;
      if (bodyChunks.length > 0) {
        const joined = new Uint8Array(bodyLength);
        let off = 0;
        for (const c of bodyChunks) {
          joined.set(c, off);
          off += c.length;
        }
        bodySha = sha256(joined);
      }
      out.push({
        id: `${ctx.revealTxid}i${index}`,
        revealTxid: ctx.revealTxid,
        index,
        contentType,
        parent,
        bodySha256: bodySha,
        bodyLength,
        inputIndex: ctx.inputIndex,
      });
      index++;
    }
    i = closed ? j : i + 1;
  }

  return out;
}

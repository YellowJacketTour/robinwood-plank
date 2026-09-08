/**
 * Ordinals envelope parsing: the keyless Bitcoin path.
 *
 * This exists so Bitcoin inscriptions do not depend on Hiro, Magic Eden, or
 * UniSat. On 2026-09-08 those three answered 410, 503, and 404 respectively,
 * which is the whole argument for parsing tapscript ourselves.
 *
 * A parser that reads attacker-supplied witness bytes is also the most
 * hostile input surface in the package, so the malformed cases below matter
 * as much as the happy path.
 */
import { test } from "node:test";
import { eq, ok, sha256Stub } from "./_expect.ts";
import { parseEnvelopes } from "../src/hose/adapters/envelope.ts";

const sha = sha256Stub();
const TXID = "a".repeat(64);

const OP_FALSE = 0x00;
const OP_IF = 0x63;
const OP_ENDIF = 0x68;
const OP_1 = 0x51; // tag 1: content type
const OP_3 = 0x53; // tag 3: parent

/** Direct push of up to 75 bytes: the opcode is the length. */
function push(bytes: number[] | Uint8Array): number[] {
  const b = [...bytes];
  if (b.length >= 0x4c) throw new Error("use pushdata1 in this helper set");
  return [b.length, ...b];
}
const ascii = (s: string) => [...new TextEncoder().encode(s)];
const ORD = ascii("ord");

function envelope(opts: {
  contentType?: string;
  parentLe?: number[];
  body?: string;
}): number[] {
  const out = [OP_FALSE, OP_IF, ...push(ORD)];
  if (opts.contentType !== undefined) out.push(OP_1, ...push(ascii(opts.contentType)));
  if (opts.parentLe) out.push(OP_3, ...push(opts.parentLe));
  if (opts.body !== undefined) out.push(OP_FALSE, ...push(ascii(opts.body)));
  out.push(OP_ENDIF);
  return out;
}

test("a single envelope yields one inscription with id, type, and body hash", () => {
  const script = new Uint8Array(envelope({ contentType: "text/plain", body: "hello" }));
  const found = parseEnvelopes(script, { revealTxid: TXID, inputIndex: 0 }, sha);

  eq(found.length, 1);
  eq(found[0]!.id, `${TXID}i0`, "the canonical ordinals id is <txid>i<index>");
  eq(found[0]!.contentType, "text/plain");
  eq(found[0]!.bodyLength, 5);
  eq(found[0]!.bodySha256, sha(new TextEncoder().encode("hello")),
    "the body is hashed so a couriered copy can be checked against it");
  eq(found[0]!.parent, null);
});

test("several envelopes in one script are indexed in order", () => {
  const script = new Uint8Array([
    ...envelope({ contentType: "text/plain", body: "one" }),
    ...envelope({ contentType: "text/plain", body: "two" }),
    ...envelope({ contentType: "image/png", body: "three" }),
  ]);
  const found = parseEnvelopes(script, { revealTxid: TXID, inputIndex: 0 }, sha);

  eq(found.length, 3, "a batch reveal is several inscriptions in one witness");
  eq(found.map((f) => f.id), [`${TXID}i0`, `${TXID}i1`, `${TXID}i2`]);
  eq(found[2]!.contentType, "image/png");
});

test("startIndex continues numbering across inputs of the same reveal", () => {
  const script = new Uint8Array(envelope({ body: "x" }));
  const found = parseEnvelopes(script, { revealTxid: TXID, inputIndex: 2, startIndex: 7 }, sha);
  eq(found[0]!.id, `${TXID}i7`, "index is per reveal transaction, not per input");
  eq(found[0]!.inputIndex, 2, "but the witness position is kept for provenance");
});

test("a parent tag decodes to an inscription id: this is the HARD collection edge", () => {
  // Tag 3 carries the parent txid in little-endian, optionally with an index.
  const parentTxidBe = "b".repeat(64);
  const le: number[] = [];
  for (let i = 62; i >= 0; i -= 2) le.push(parseInt(parentTxidBe.slice(i, i + 2), 16));

  const script = new Uint8Array(envelope({ contentType: "text/plain", parentLe: le, body: "child" }));
  const found = parseEnvelopes(script, { revealTxid: TXID, inputIndex: 0 }, sha);

  eq(found.length, 1);
  eq(found[0]!.parent, `${parentTxidBe}i0`,
    "a creator's own on-chain declaration of membership, requiring no venue");
});

test("a body-less envelope still inscribes", () => {
  const script = new Uint8Array(envelope({ contentType: "text/plain" }));
  const found = parseEnvelopes(script, { revealTxid: TXID, inputIndex: 0 }, sha);
  eq(found.length, 1);
  eq(found[0]!.bodyLength, 0);
  eq(found[0]!.bodySha256, null, "no body means no body hash, not a hash of nothing");
});

test("non-envelope scripts and near-misses produce nothing", () => {
  const noop = (b: number[]) =>
    eq(parseEnvelopes(new Uint8Array(b), { revealTxid: TXID, inputIndex: 0 }, sha).length, 0);

  noop([]);
  noop([0x51, 0x52, 0x53]);                         // an ordinary script
  noop([OP_FALSE, OP_IF, ...push(ascii("orx")), OP_ENDIF]); // wrong protocol tag
  noop([OP_IF, ...push(ORD), OP_ENDIF]);            // missing the OP_FALSE
  noop([OP_FALSE, OP_IF]);                          // truncated before the tag
});

test("a truncated push cannot read past the end of the script", () => {
  // Claims 40 bytes of payload but supplies two: a hostile witness.
  const script = new Uint8Array([OP_FALSE, OP_IF, 40, 0x6f, 0x72]);
  const found = parseEnvelopes(script, { revealTxid: TXID, inputIndex: 0 }, sha);
  eq(found.length, 0, "the parser refuses rather than reading out of bounds");
});

test("an unterminated envelope is not emitted", () => {
  // Everything is well formed except the closing OP_ENDIF.
  const body = [OP_FALSE, OP_IF, ...push(ORD), OP_1, ...push(ascii("text/plain"))];
  const found = parseEnvelopes(new Uint8Array(body), { revealTxid: TXID, inputIndex: 0 }, sha);
  eq(found.length, 0, "an unclosed envelope is not an inscription");
});

test("a valid envelope after garbage is still found", () => {
  const script = new Uint8Array([
    0x51, 0x00, 0x63, 0xff, 0x00,
    ...envelope({ contentType: "text/plain", body: "survivor" }),
  ]);
  const found = parseEnvelopes(script, { revealTxid: TXID, inputIndex: 0 }, sha);
  eq(found.length, 1, "one malformed prefix must not blind us to the rest of the witness");
  ok(found[0]!.bodyLength === 8);
});

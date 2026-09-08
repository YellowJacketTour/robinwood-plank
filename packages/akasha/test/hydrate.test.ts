/**
 * The hydrate corrections, pinned.
 *
 * These tests exist because the ORIGINAL design was unsound and shipped in a
 * document others could implement from. Each one fails if the old rule
 * returns.
 */
import { test } from "node:test";
import { eq, ok, throws, sha256Stub } from "./_expect.ts";
import {
  ObservationLedger,
  acceptReport,
  classifyUri,
  committedDigest,
  TWO_HASHES_ARE_NOT_CONFIRMATION,
  K_DISTINCT_ASN,
  QUORUM_WINDOW_MS,
  MAX_BODY_BYTES,
} from "../src/hydrate/accept.ts";
import { NonceIssuer } from "../src/hydrate/nonce.ts";

const sha = sha256Stub();

test("the superseded two-hash rule is a function that throws", () => {
  throws(
    () => TWO_HASHES_ARE_NOT_CONFIRMATION(),
    /IPs are a market/,
    "the old rule must be impossible to call by accident"
  );
});

test("two same-network HTTPS reports stay unconfirmed", () => {
  const now = { t: 1_000_000 };
  const deps = { now: () => now.t, sha256: sha };
  const ledger = new ObservationLedger(deps);

  const body = new TextEncoder().encode('{"name":"garbage"}');
  const base = {
    target: "eth:0xabc:1",
    uri: "https://example.test/1.json",
    body,
    nonceValid: true,
    asnHmac: "asn-A",
  };

  const r1 = acceptReport({ ...base, sessionHmac: "s1" }, ledger, deps);
  now.t += 60_000;
  const r2 = acceptReport({ ...base, sessionHmac: "s2" }, ledger, deps);

  ok(r1.accepted && !("canonical" in r1 && r1.canonical), "first report is an observation");
  ok(r2.accepted, "second report is accepted as an observation");
  eq(ledger.status(base.target), "unconfirmed", "two browsers on ONE network confirm nothing");
});

test("K distinct networks spanning the window are required to confirm HTTPS", () => {
  const now = { t: 5_000_000 };
  const deps = { now: () => now.t, sha256: sha };
  const ledger = new ObservationLedger(deps);
  const body = new TextEncoder().encode('{"name":"real"}');
  const base = {
    target: "eth:0xdef:7",
    uri: "https://example.test/7.json",
    body,
    nonceValid: true,
  };

  for (let i = 0; i < K_DISTINCT_ASN; i++) {
    acceptReport({ ...base, sessionHmac: `s${i}`, asnHmac: `asn-${i}` }, ledger, deps);
    now.t += QUORUM_WINDOW_MS / 2;
  }
  eq(ledger.status(base.target), "confirmed", "K networks across the window promote");
});

test("a clash disputes the target and forces a server fetch", () => {
  const now = { t: 9_000_000 };
  const deps = { now: () => now.t, sha256: sha };
  const ledger = new ObservationLedger(deps);
  const target = "eth:0x111:3";

  acceptReport(
    {
      target,
      uri: "https://example.test/3.json",
      body: new TextEncoder().encode("A"),
      nonceValid: true,
      sessionHmac: "s1",
      asnHmac: "asn-1",
    },
    ledger,
    deps
  );
  const clash = acceptReport(
    {
      target,
      uri: "https://example.test/3.json",
      body: new TextEncoder().encode("B"),
      nonceValid: true,
      sessionHmac: "s2",
      asnHmac: "asn-2",
    },
    ledger,
    deps
  );

  ok(clash.accepted && "status" in clash && clash.status === "disputed", "clash disputes");
  eq(ledger.status(target), "disputed");
});

test("no viewport nonce means no write at all", () => {
  const deps = { now: () => 1, sha256: sha };
  const ledger = new ObservationLedger(deps);
  const r = acceptReport(
    {
      target: "eth:0x222:9",
      uri: "https://example.test/9.json",
      body: new TextEncoder().encode("x"),
      nonceValid: false,
      sessionHmac: "s",
      asnHmac: "a",
    },
    ledger,
    deps
  );
  eq(r.accepted, false, "an unadmitted report is not stored");
});

test("a content-addressed body is canonical from ONE report, and a wrong body is refused", () => {
  const deps = { now: () => 1, sha256: sha };
  const ledger = new ObservationLedger(deps);
  const body = new TextEncoder().encode("the real bytes");
  const digest = sha(body).slice(2);

  const good = acceptReport(
    {
      target: "eth:0x333:1",
      uri: `sha256://${digest}`,
      body,
      nonceValid: true,
      sessionHmac: "s",
      asnHmac: "a",
    },
    ledger,
    deps
  );
  ok(good.accepted && "canonical" in good && good.canonical, "matching digest is canonical alone");

  const bad = acceptReport(
    {
      target: "eth:0x333:2",
      uri: `sha256://${digest}`,
      body: new TextEncoder().encode("poison"),
      nonceValid: true,
      sessionHmac: "s",
      asnHmac: "a",
    },
    ledger,
    deps
  );
  eq(bad.accepted, false, "a body that does not match its commitment is refused");
});

test("a content-addressed URI we cannot verify is refused, never downgraded to canonical", () => {
  const deps = { now: () => 1, sha256: sha };
  const ledger = new ObservationLedger(deps);
  const r = acceptReport(
    {
      target: "eth:0x444:1",
      uri: "ipfs://bafybeigdyrztktx5gcnrkjmkbmtxbiabcdefghijklmnopqrstuvwxyz234",
      body: new TextEncoder().encode("anything"),
      nonceValid: true,
      sessionHmac: "s",
      asnHmac: "a",
    },
    ledger,
    deps
  );
  eq(r.accepted, false, "an unverifiable CID must not be accepted as canonical");
  eq(committedDigest("ipfs://bafy..."), null, "we do not pretend to decode multihash here");
});

test("oversized bodies are refused before hashing", () => {
  const deps = { now: () => 1, sha256: sha };
  const ledger = new ObservationLedger(deps);
  const r = acceptReport(
    {
      target: "eth:0x555:1",
      uri: "https://example.test/big.json",
      body: new Uint8Array(MAX_BODY_BYTES + 1),
      nonceValid: true,
      sessionHmac: "s",
      asnHmac: "a",
    },
    ledger,
    deps
  );
  eq(r.accepted, false, "decompression bombs are not metadata");
});

test("classifyUri is conservative: anything unprovable is mutable", () => {
  eq(classifyUri("ipfs://bafy123"), "content_addressed");
  eq(classifyUri("https://gw.example/ipfs/bafybeigdyrztktx5gcnrkjmkbmtxbiabcdefghijklmnopqrstuvwxyz234"), "content_addressed");
  eq(classifyUri("https://api.opensea.io/order/123"), "https_mutable", "a URL containing 'order' is NOT a signed order");
  eq(classifyUri("https://example.test/meta.json"), "https_mutable");
});

test("a viewport nonce is bound to one target and expires", () => {
  const now = { t: 1_000 };
  const issuer = new NonceIssuer({
    hmac: (k, m) => sha(new TextEncoder().encode(k + m)),
    now: () => now.t,
    serverKey: "server-secret",
  });
  const onScreen = (t: string) => t === "eth:0xaaa:1";

  eq(issuer.issue("eth:0xbbb:2", "sess", onScreen), null, "cannot mint for an off-screen target");

  const issued = issuer.issue("eth:0xaaa:1", "sess", onScreen);
  ok(issued, "on-screen target gets a nonce");
  ok(issuer.verify(issued!.nonce, "eth:0xaaa:1"), "verifies for its own target");
  eq(issuer.verify(issued!.nonce, "eth:0xccc:3"), null, "cannot be replayed onto another target");

  now.t += 10 * 60_000;
  eq(issuer.verify(issued!.nonce, "eth:0xaaa:1"), null, "expires");
});

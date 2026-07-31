import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import {
  adminMessage,
  adminAddresses,
  adminPayloadHash,
  verifyAdminProof,
  ADMIN_SIGNATURE_WINDOW_MS,
} from "../../lib/admin-auth";
import { sanitizePlaylist, WOODAMP_PLAYLIST } from "../../lib/woodamp-playlist";

/**
 * Locks in the WoodAmp Phase 2 contracts:
 * - sanitizePlaylist is the single validator shared by the /admin client, the
 *   PUT /api/music/playlist route, and the store's read path — a payload it
 *   accepts must round-trip unchanged (the client signs JSON of the sanitized
 *   list and the server verifies that exact JSON), and page-link "audio"
 *   sources that can never play in an <audio> element must be rejected at
 *   save time, not discovered broken in the player.
 * - verifyAdminProof fails closed: garbage signatures, stale timestamps,
 *   payload substitution after signing, and non-allowlisted signers all
 *   reject. A signature authorizes exactly one action + payload + window.
 */

const admin = new Wallet(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
);
const stranger = new Wallet(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
);
const ENV = admin.address;

const VALID_TRACKS = [
  {
    id: "sugar",
    title: "Sugar",
    artist: "Plank Community Radio",
    src: "/audio/sugar.mp3",
    source: "hosted",
  },
  {
    id: "remote-jam",
    title: "  Remote Jam  ",
    artist: "Community",
    src: "https://cdn.example.com/jam.mp3",
    source: "remote",
    duration: 191,
  },
];

async function signedProof(
  wallet: Wallet,
  payloadJson: string,
  timestamp: number,
  action = "woodamp-playlist"
) {
  return {
    address: wallet.address,
    timestamp,
    signature: await wallet.signMessage(
      adminMessage(action, timestamp, adminPayloadHash(payloadJson))
    ),
  };
}

test("sanitizePlaylist accepts the static seed manifest unchanged", () => {
  const parsed = sanitizePlaylist([...WOODAMP_PLAYLIST]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.tracks, [...WOODAMP_PLAYLIST]);
});

test("sanitizePlaylist trims text, keeps duration, and is idempotent", () => {
  const first = sanitizePlaylist(VALID_TRACKS);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.tracks[1].title, "Remote Jam");
  assert.equal(first.tracks[1].duration, 191);
  // Idempotence is what lets client and server sign/verify the same JSON.
  const second = sanitizePlaylist(first.tracks);
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(JSON.stringify(second.tracks), JSON.stringify(first.tracks));
  }
});

test("sanitizePlaylist rejects empty lists, bad ids, duplicates, and bad shapes", () => {
  assert.equal(sanitizePlaylist([]).ok, false);
  assert.equal(sanitizePlaylist("nope").ok, false);
  assert.equal(
    sanitizePlaylist([{ ...VALID_TRACKS[0], id: "Bad Id!" }]).ok,
    false
  );
  assert.equal(
    sanitizePlaylist([VALID_TRACKS[0], VALID_TRACKS[0]]).ok,
    false
  );
  assert.equal(
    sanitizePlaylist([{ ...VALID_TRACKS[0], title: "" }]).ok,
    false
  );
});

test("sanitizePlaylist rejects sources that cannot play in <audio>", () => {
  const cases = [
    // Page links, not audio files.
    "https://soundcloud.com/artist/track",
    "https://www.youtube.com/watch?v=abc",
    "https://youtu.be/abc",
    "https://open.spotify.com/track/abc",
    // Insecure or malformed.
    "http://cdn.example.com/jam.mp3",
    "not-a-url",
  ];
  for (const src of cases) {
    const parsed = sanitizePlaylist([
      { ...VALID_TRACKS[0], id: "x", src, source: "remote" },
    ]);
    assert.equal(parsed.ok, false, `should reject ${src}`);
  }
  // Hosted sources must be same-origin paths, not protocol-relative.
  assert.equal(
    sanitizePlaylist([
      { ...VALID_TRACKS[0], src: "//evil.example.com/a.mp3", source: "hosted" },
    ]).ok,
    false
  );
});

test("a genuine admin signature over the exact payload verifies", async () => {
  const payload = JSON.stringify(VALID_TRACKS);
  const now = Date.now();
  const proof = await signedProof(admin, payload, now);
  const verdict = verifyAdminProof("woodamp-playlist", payload, proof, {
    now,
    env: ENV,
  });
  assert.deepEqual(verdict, { ok: true, address: admin.address.toLowerCase() });
});

test("payload substitution after signing rejects", async () => {
  const now = Date.now();
  const proof = await signedProof(admin, JSON.stringify(VALID_TRACKS), now);
  const tampered = JSON.stringify([VALID_TRACKS[0]]);
  const verdict = verifyAdminProof("woodamp-playlist", tampered, proof, {
    now,
    env: ENV,
  });
  assert.deepEqual(verdict, { ok: false, error: "BAD_SIGNATURE" });
});

test("a signature for one action does not authorize another", async () => {
  const payload = JSON.stringify(VALID_TRACKS);
  const now = Date.now();
  const proof = await signedProof(admin, payload, now, "other-action");
  const verdict = verifyAdminProof("woodamp-playlist", payload, proof, {
    now,
    env: ENV,
  });
  assert.deepEqual(verdict, { ok: false, error: "BAD_SIGNATURE" });
});

test("stale and future-dated timestamps reject", async () => {
  const payload = JSON.stringify(VALID_TRACKS);
  const now = Date.now();
  const stale = await signedProof(
    admin,
    payload,
    now - ADMIN_SIGNATURE_WINDOW_MS - 1000
  );
  assert.deepEqual(
    verifyAdminProof("woodamp-playlist", payload, stale, { now, env: ENV }),
    { ok: false, error: "STALE" }
  );
  const future = await signedProof(
    admin,
    payload,
    now + ADMIN_SIGNATURE_WINDOW_MS + 1000
  );
  assert.deepEqual(
    verifyAdminProof("woodamp-playlist", payload, future, { now, env: ENV }),
    { ok: false, error: "STALE" }
  );
});

test("a non-allowlisted signer rejects even with a valid signature", async () => {
  const payload = JSON.stringify(VALID_TRACKS);
  const now = Date.now();
  const proof = await signedProof(stranger, payload, now);
  const verdict = verifyAdminProof("woodamp-playlist", payload, proof, {
    now,
    env: ENV,
  });
  assert.deepEqual(verdict, { ok: false, error: "UNAUTHORIZED" });
});

test("garbage signatures fail closed", () => {
  const payload = JSON.stringify(VALID_TRACKS);
  const now = Date.now();
  const verdict = verifyAdminProof(
    "woodamp-playlist",
    payload,
    { address: admin.address, timestamp: now, signature: "0xdeadbeef" },
    { now, env: ENV }
  );
  assert.deepEqual(verdict, { ok: false, error: "BAD_SIGNATURE" });
});

test("an address mismatched with the recovered signer rejects", async () => {
  const payload = JSON.stringify(VALID_TRACKS);
  const now = Date.now();
  const proof = await signedProof(admin, payload, now);
  const verdict = verifyAdminProof(
    "woodamp-playlist",
    payload,
    { ...proof, address: stranger.address },
    { now, env: ENV }
  );
  assert.deepEqual(verdict, { ok: false, error: "BAD_SIGNATURE" });
});

test("adminAddresses: env parses a comma-separated list; unset falls back to treasuries", () => {
  const list = adminAddresses(` ${admin.address} , ${stranger.address} `);
  assert.deepEqual(list, [
    admin.address.toLowerCase(),
    stranger.address.toLowerCase(),
  ]);
  const fallback = adminAddresses("");
  assert.equal(fallback.length, 2);
  for (const entry of fallback) assert.match(entry, /^0x[0-9a-f]{40}$/);
});

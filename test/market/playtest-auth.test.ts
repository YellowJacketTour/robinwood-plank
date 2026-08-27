import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanDisplayName, clearSessionCookie, inviteAllowed, newSessionToken, normalizeInvite, playtestEnabled, playtestMutationOriginAllowed, playtestRp, sessionCookie, sha256 } from "../../lib/playtest-auth-core";

const saved = {
  origin: process.env.PLANK_PLAYTEST_ORIGIN,
  rp: process.env.PLANK_PLAYTEST_RP_ID,
  invites: process.env.PLANK_PLAYTEST_INVITE_HASHES,
  enabled: process.env.PLANK_PLAYTEST_ENABLED,
};

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    const env = key === "origin" ? "PLANK_PLAYTEST_ORIGIN" : key === "rp" ? "PLANK_PLAYTEST_RP_ID" : key === "enabled" ? "PLANK_PLAYTEST_ENABLED" : "PLANK_PLAYTEST_INVITE_HASHES";
    if (value === undefined) delete process.env[env]; else process.env[env] = value;
  }
});

test("invite comparison accepts only configured SHA-256 hashes", () => {
  const invite = "correct horse battery staple invitation";
  process.env.PLANK_PLAYTEST_INVITE_HASHES = `${sha256(invite)},not-a-hash`;
  assert.equal(inviteAllowed(invite), true);
  assert.equal(inviteAllowed("wrong"), false);
});

test("invite and display-name normalization is deterministic and bounded", () => {
  assert.equal(normalizeInvite("  code  "), "code");
  assert.equal(cleanDisplayName("  Plank   Friend "), "Plank Friend");
  assert.equal(cleanDisplayName("x".repeat(41)), null);
});

test("RP settings require HTTPS except loopback and bind RP to origin host", () => {
  process.env.PLANK_PLAYTEST_ENABLED = "true";
  process.env.PLANK_PLAYTEST_ORIGIN = "https://play.plank.love";
  process.env.PLANK_PLAYTEST_RP_ID = "plank.love";
  assert.deepEqual(playtestRp(), { rpID: "plank.love", origin: "https://play.plank.love", rpName: "Plank Love Game Laboratory" });
  process.env.PLANK_PLAYTEST_RP_ID = "attacker.example";
  assert.throws(() => playtestRp());
  process.env.PLANK_PLAYTEST_ORIGIN = "http://plank.love";
  process.env.PLANK_PLAYTEST_RP_ID = "plank.love";
  assert.throws(() => playtestRp());
});

test("sessions use opaque 256-bit tokens and hardened host cookies", () => {
  const a = newSessionToken();
  assert.notEqual(a, newSessionToken());
  assert.equal(Buffer.from(a, "base64url").length, 32);
  assert.match(sessionCookie(a), /^__Host-plank_lab=.*; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict$/);
  assert.match(clearSessionCookie(), /Max-Age=0; HttpOnly; Secure; SameSite=Strict$/);
});

test("cookie-authenticated mutations require the exact configured origin", () => {
  process.env.PLANK_PLAYTEST_ENABLED = "true";
  process.env.PLANK_PLAYTEST_ORIGIN = "https://play.plank.love";
  assert.equal(playtestMutationOriginAllowed(new Request("https://play.plank.love/api", { headers: { origin: "https://play.plank.love" } })), true);
  assert.equal(playtestMutationOriginAllowed(new Request("https://play.plank.love/api", { headers: { origin: "https://evil.plank.love" } })), false);
  assert.equal(playtestMutationOriginAllowed(new Request("https://play.plank.love/api")), false);
});

test("the unofficial laboratory fails closed unless explicitly enabled", () => {
  delete process.env.PLANK_PLAYTEST_ENABLED;
  process.env.PLANK_PLAYTEST_ORIGIN = "https://play.plank.love";
  assert.equal(playtestEnabled(), false);
  assert.equal(playtestMutationOriginAllowed(new Request("https://play.plank.love/api", { headers: { origin: "https://play.plank.love" } })), false);
  assert.throws(() => playtestRp(), /disabled/);
});

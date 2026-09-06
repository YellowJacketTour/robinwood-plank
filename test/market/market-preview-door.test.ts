import assert from "node:assert/strict";
import test from "node:test";
import { buildDoorCookieValue, verifyDoorCookieValue, verifyDoorCredentials, doorSlug } from "../../lib/market-preview-door";

test("door: wrong user or wrong pin is rejected; right pair is accepted; matching is case-insensitive on the user only", () => {
  assert.equal(verifyDoorCredentials("OG", "220593"), true);
  assert.equal(verifyDoorCredentials("og", "220593"), true);
  assert.equal(verifyDoorCredentials("OG", "220594"), false);
  assert.equal(verifyDoorCredentials("someone", "220593"), false);
  assert.equal(verifyDoorCredentials("", ""), false);
});

test("door cookie: round-trips, expires, and rejects tampering", () => {
  const now = Date.now();
  const value = buildDoorCookieValue("OG", now);
  assert.equal(verifyDoorCookieValue(value, now), true);
  assert.equal(verifyDoorCookieValue(value, now + 8 * 24 * 60 * 60 * 1000), false, "a week later it is dead");
  const [subject, exp, mac] = value.split(".");
  assert.equal(verifyDoorCookieValue(`${subject}.${Number(exp) + 1}.${mac}`, now), false, "extended expiry fails the MAC");
  assert.equal(verifyDoorCookieValue(`door:other.${exp}.${mac}`, now), false);
  assert.equal(verifyDoorCookieValue("0xabc.123.deadbeef", now), false, "an admin-shaped cookie is not a door cookie");
  assert.equal(verifyDoorCookieValue(undefined, now), false);
});

test("door slug is configurable and never empty", () => {
  assert.ok(doorSlug().length > 8);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../lib/playtest-rooms.ts", import.meta.url), "utf8");

function payloadFor(eventType: string): string {
  const marker = `\"${eventType}\"`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${eventType} event must exist`);
  return source.slice(start, source.indexOf(");", start) + 2);
}

function dynamicBotPayload(): string {
  const marker = "`admin.bots.${";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "admin bot event must exist");
  return source.slice(start, source.indexOf(");", start) + 2);
}

test("running launch event cannot disclose outcome or deadline", () => {
  const payload = payloadFor("round.launched");
  assert.doesNotMatch(payload, /crashAt|crashBps|reveal|due/);
  assert.match(payload, /commitment/);
});

test("bet event cannot disclose an unexecuted auto-lock target", () => {
  const payload = payloadFor("bet.accepted");
  assert.doesNotMatch(payload, /targetBps|requestedTarget/);
  assert.match(payload, /stake/);
});

test("bot event cannot broadcast host strategy configuration", () => {
  const payload = dynamicBotPayload();
  assert.doesNotMatch(payload, /configuration|bot_profile|profile|target/);
  assert.match(payload, /affected/);
});

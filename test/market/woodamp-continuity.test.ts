import assert from "node:assert/strict";
import { test } from "node:test";
import { clampResumePosition, parseWoodAmpResume, resolveWoodAmpResume } from "../../lib/woodamp-continuity";
import type { WoodAmpTrack } from "../../lib/woodamp-playlist";

const saved = { version: 1 as const, trackId: "a", source: "/audio/a.mp3", position: 43, shuffle: true, repeat: false };
const a: WoodAmpTrack = { id: "a", title: "A", artist: "Artist", src: saved.source, source: "hosted" };
test("restores by track identity after playlist reordering", () => {
  assert.deepEqual(resolveWoodAmpResume([{ ...a, id: "b" }, a], saved), { index: 1, position: 43 });
});
test("removed, replaced and embedded tracks cannot inherit an audio position", () => {
  assert.equal(resolveWoodAmpResume([], saved), null);
  assert.equal(resolveWoodAmpResume([{ ...a, src: "/audio/replacement.mp3" }], saved), null);
  assert.equal(resolveWoodAmpResume([{ ...a, source: "embed-youtube" }], saved), null);
});
test("untrusted local storage is bounded and never restores a playback intent", () => {
  assert.deepEqual(parseWoodAmpResume(JSON.stringify({ ...saved, playing: true, token: "secret" })), saved);
  for (const raw of [null, "{", "null", "x".repeat(8193), JSON.stringify({ ...saved, position: -1 }), JSON.stringify({ ...saved, position: "43" }), JSON.stringify({ ...saved, version: 2 })]) {
    assert.equal(parseWoodAmpResume(raw), null);
  }
});
test("completed tracks restart and invalid metadata cannot produce an invalid seek", () => {
  assert.equal(clampResumePosition(43, 100), 43);
  assert.equal(clampResumePosition(100, 100), 0);
  assert.equal(clampResumePosition(999, 100), 0);
  assert.equal(clampResumePosition(43, Infinity), 0);
});

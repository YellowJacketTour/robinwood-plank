import assert from "node:assert/strict";
import test from "node:test";
import { normalizePostMedia } from "../../integrations/plankspace-app/app/post-media";
import { resolveUploadPath, uploadContentType } from "../../lib/uploads";

test("voice attachment survives post normalization and keeps playback MIME", () => {
  for (const [ext, mime] of [["weba", "audio/webm"], ["ogg", "audio/ogg"], ["m4a", "audio/mp4"]]) {
    const name = `0123456789ab-voice.${ext}`;
    const media = normalizePostMedia({ mediaUrl: `/api/media/${name}`, mediaType: "audio", mediaAlt: "Voice note" });
    assert.equal(media.mediaType, "audio");
    assert.equal(media.mediaAlt, "Voice note");
    assert.ok(resolveUploadPath(name));
    assert.equal(uploadContentType(name), mime);
  }
});

test("audio does not permit script URLs or filesystem paths", () => {
  for (const mediaUrl of ["javascript:alert(1)", "file:///private.wav", "/api/media/../../secret.weba"]) {
    assert.throws(() => normalizePostMedia({ mediaUrl, mediaType: "audio" }));
  }
  assert.equal(resolveUploadPath("../../secret.weba"), null);
});

test("adding audio preserves video and empty attachment behavior", () => {
  assert.equal(normalizePostMedia({ mediaUrl: "https://example.com/movie.mp4", mediaType: "video" }).mediaType, "video");
  assert.equal(normalizePostMedia({ mediaUrl: "", mediaType: "audio" }).mediaType, "");
});

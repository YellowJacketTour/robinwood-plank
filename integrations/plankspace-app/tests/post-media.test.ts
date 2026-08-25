import assert from "node:assert/strict";
import test from "node:test";
import { normalizePostMedia } from "../app/post-media";

test("normalizes pictures, videos, links, and approved gifts", () => {
  assert.deepEqual(normalizePostMedia({mediaUrl:"https://example.com/plank.gif",mediaType:"image",mediaAlt:" Plank GIF "}),{mediaUrl:"https://example.com/plank.gif",mediaType:"image",mediaAlt:"Plank GIF"});
  assert.equal(normalizePostMedia({mediaUrl:"https://example.com/video.mp4",mediaType:"video"}).mediaType,"video");
  assert.equal(normalizePostMedia({mediaUrl:"https://plank.love",mediaType:"link"}).mediaType,"link");
  assert.deepEqual(normalizePostMedia({mediaUrl:"gift:🪵",mediaType:"gift"}),{mediaUrl:"gift:🪵",mediaType:"gift",mediaAlt:""});
});

test("rejects unsafe links and unapproved gift payloads", () => {
  assert.throws(()=>normalizePostMedia({mediaUrl:"javascript:alert(1)",mediaType:"link"}),/HTTPS/);
  assert.throws(()=>normalizePostMedia({mediaUrl:"gift:<script>",mediaType:"gift"}),/gift tray/);
});

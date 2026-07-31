import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeBanner,
  sanitizeCollections,
  sanitizeFlags,
  sanitizeIntro,
  sanitizeLearn,
} from "../../lib/content-docs";
import {
  classifyTrackUrl,
  sanitizePlaylist,
  youTubeVideoId,
} from "../../lib/woodamp-playlist";

/**
 * Locks in the admin-console Phase 3 contracts:
 * - classifyTrackUrl is authoritative for what a URL IS (hosted file, direct
 *   audio, YouTube/SoundCloud embed, external showcase) — the validator
 *   rejects stored source values that disagree, so a page link can never be
 *   stored as a "playable" track again.
 * - The CMS doc sanitizers fail closed on malformed payloads; the signed
 *   JSON is always the sanitized JSON.
 */

test("classifyTrackUrl: same-origin paths are hosted", () => {
  assert.equal(classifyTrackUrl("/audio/sugar.mp3"), "hosted");
  assert.equal(classifyTrackUrl("/api/media/abc123def456-song.mp3"), "hosted");
  assert.equal(classifyTrackUrl("//evil.example.com/a.mp3"), null);
});

test("classifyTrackUrl: platform pages route to embeds/external", () => {
  assert.equal(
    classifyTrackUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    "embed-youtube"
  );
  assert.equal(classifyTrackUrl("https://youtu.be/dQw4w9WgXcQ"), "embed-youtube");
  assert.equal(
    classifyTrackUrl("https://soundcloud.com/artist/track"),
    "embed-soundcloud"
  );
  assert.equal(classifyTrackUrl("https://x.com/user/status/123"), "external");
  assert.equal(
    classifyTrackUrl("https://twitter.com/user/status/123"),
    "external"
  );
  assert.equal(
    classifyTrackUrl("https://open.spotify.com/track/abc"),
    "external"
  );
  // A YouTube host URL with no extractable video id can't embed.
  assert.equal(classifyTrackUrl("https://www.youtube.com/@channel"), "external");
  // Anything else https is treated as a direct audio file.
  assert.equal(classifyTrackUrl("https://cdn.example.com/a.mp3"), "remote");
  assert.equal(classifyTrackUrl("http://cdn.example.com/a.mp3"), null);
});

test("youTubeVideoId extracts watch/short/share ids", () => {
  assert.equal(
    youTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    "dQw4w9WgXcQ"
  );
  assert.equal(youTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=10"), "dQw4w9WgXcQ");
  assert.equal(
    youTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"),
    "dQw4w9WgXcQ"
  );
  assert.equal(youTubeVideoId("https://www.youtube.com/@channel"), null);
});

test("sanitizePlaylist rejects a source that disagrees with the URL", () => {
  const base = { id: "x", title: "T", artist: "A" };
  assert.equal(
    sanitizePlaylist([
      { ...base, src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", source: "remote" },
    ]).ok,
    false
  );
  assert.equal(
    sanitizePlaylist([
      { ...base, src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", source: "embed-youtube" },
    ]).ok,
    true
  );
  assert.equal(
    sanitizePlaylist([
      { ...base, src: "https://x.com/user/status/1", source: "external" },
    ]).ok,
    true
  );
});

test("sanitizeLearn: visibility ids only, deduplicated", () => {
  const ok = sanitizeLearn({ hidden: ["faq", "faq", "vault-math"] });
  assert.deepEqual(ok, { ok: true, value: { hidden: ["faq", "vault-math"] } });
  assert.equal(sanitizeLearn({ hidden: ["Bad Id!"] }).ok, false);
  assert.equal(sanitizeLearn({}).ok, false);
});

test("sanitizeIntro: requires complete phrases, keeps at least one", () => {
  const ok = sanitizeIntro({
    phrases: [{ eyebrow: " E ", headline: "H", subline: "S" }],
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.phrases[0].eyebrow, "E");
  assert.equal(sanitizeIntro({ phrases: [] }).ok, false);
  assert.equal(
    sanitizeIntro({ phrases: [{ eyebrow: "E", headline: "", subline: "S" }] }).ok,
    false
  );
});

test("sanitizeBanner: enabled requires text; links validated", () => {
  assert.equal(sanitizeBanner({ enabled: true, text: "", href: "" }).ok, false);
  assert.equal(
    sanitizeBanner({ enabled: true, text: "Hi", href: "javascript:alert(1)" }).ok,
    false
  );
  assert.equal(
    sanitizeBanner({ enabled: true, text: "Hi", href: "/market" }).ok,
    true
  );
  assert.equal(
    sanitizeBanner({ enabled: false, text: "", href: "" }).ok,
    true
  );
});

test("sanitizeFlags: tri-state tradePaused only", () => {
  assert.deepEqual(sanitizeFlags({ tradePaused: null }), {
    ok: true,
    value: { tradePaused: null },
  });
  assert.deepEqual(sanitizeFlags({ tradePaused: true }), {
    ok: true,
    value: { tradePaused: true },
  });
  assert.deepEqual(sanitizeFlags({}), { ok: true, value: { tradePaused: null } });
  assert.equal(sanitizeFlags({ tradePaused: "yes" }).ok, false);
});

test("sanitizeCollections: address, standard, fee bounds, dup slugs, vault rules", () => {
  const good = {
    slug: "test-collection",
    name: "Test",
    contractAddress: "0x" + "ab".repeat(20),
    tokenStandard: "ERC721",
    feeBps: 50,
    vaultAddress: "",
    notes: "",
  };
  assert.equal(sanitizeCollections({ staged: [good] }).ok, true);
  assert.equal(
    sanitizeCollections({ staged: [good, good] }).ok,
    false // duplicate slug
  );
  assert.equal(
    sanitizeCollections({ staged: [{ ...good, contractAddress: "0x123" }] }).ok,
    false
  );
  assert.equal(
    sanitizeCollections({ staged: [{ ...good, feeBps: 5000 }] }).ok,
    false
  );
  // Vault address: optional, hex when present, ERC721-only.
  const withVault = { ...good, vaultAddress: "0x" + "cd".repeat(20) };
  assert.equal(sanitizeCollections({ staged: [withVault] }).ok, true);
  assert.equal(
    sanitizeCollections({ staged: [{ ...good, vaultAddress: "0xnope" }] }).ok,
    false
  );
  assert.equal(
    sanitizeCollections({
      staged: [{ ...withVault, tokenStandard: "ERC1155" }],
    }).ok,
    false
  );
  // Missing vaultAddress (pre-existing stored docs) defaults to "".
  const legacy = { ...good } as Record<string, unknown>;
  delete legacy.vaultAddress;
  const parsed = sanitizeCollections({ staged: [legacy] });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.staged[0].vaultAddress, "");
});

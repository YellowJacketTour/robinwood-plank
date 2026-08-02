import test from "node:test";
import assert from "node:assert/strict";
import {
  GALLERY_TABS,
  DEFAULT_GALLERY_PANEL,
  parseGalleryTab,
  toNumericTokenIds,
} from "../../lib/gallery-tabs";

test("the gallery keeps every public tab id and label", () => {
  assert.deepEqual(GALLERY_TABS, [
    { id: "gallery", label: "Grid" },
    { id: "insights", label: "Insights" },
    { id: "my-nfts", label: "My NFTs" },
  ]);
});

test("a bare /gallery resolves to the grid, and that tab writes no param", () => {
  // The canonical URL for the default panel is `/gallery` with no `tab` at all.
  // If this default ever moved, every existing bookmark would silently land
  // somewhere else, so it is pinned here rather than left implicit.
  assert.equal(DEFAULT_GALLERY_PANEL, "gallery");
  assert.equal(parseGalleryTab(null), "gallery");
});

test("?tab= round-trips the non-default panels", () => {
  assert.equal(parseGalleryTab("insights"), "insights");
  assert.equal(parseGalleryTab("my-nfts"), "my-nfts");
  // Accepted on read even though it is never written, so a hand-typed or
  // hand-edited URL behaves.
  assert.equal(parseGalleryTab("gallery"), "gallery");
});

test("an unusable ?tab= falls back rather than rendering nothing", () => {
  // Includes the shapes that actually occur: an empty param, a stale id from a
  // future release pasted into an older deploy, a near-miss spelling, and the
  // marketplace ids, which share a query-string namespace but not a panel set.
  for (const bad of ["", "  ", "My-NFTs", "mynfts", "buy-sell", "positions", "__proto__"]) {
    assert.equal(parseGalleryTab(bad), "gallery", `expected fallback for ${JSON.stringify(bad)}`);
  }
  assert.equal(parseGalleryTab(undefined), "gallery");
});

test("owned token ids convert from chain strings to gallery numbers", () => {
  // getOwnedTokenIds returns strings; GalleryNft.tokenId is a number. Comparing
  // the two without this conversion fails silently and empties the tab.
  assert.deepEqual(toNumericTokenIds(["7", "1542", "1"]), new Set([7, 1542, 1]));
  assert.deepEqual(toNumericTokenIds(new Set(["42"])), new Set([42]));
  assert.deepEqual(toNumericTokenIds([]), new Set());
});

test("a non-numeric id is dropped, never admitted as NaN", () => {
  // NaN in the Set would neither match a real tokenId nor be visible as a bug.
  const ids = toNumericTokenIds(["3", "not-a-token", "", "9"]);
  assert.deepEqual(ids, new Set([3, 9]));
  assert.equal([...ids].some(Number.isNaN), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ProfileVideoPlayer from "../../integrations/plankspace-app/app/profile-video-player";

test("profile videos expose every valid unique saved video as a visible selector", () => {
  const markup = renderToStaticMarkup(
    createElement(ProfileVideoPlayer, {
      title: "DegenWaffle featured videos",
      links: [
        "https://www.youtube.com/watch?v=OklSZmIx9-o",
        "https://youtu.be/7TFS8r_SMlI",
        "https://www.youtube.com/shorts/qmlo0F2uOGU",
        "https://youtu.be/7TFS8r_SMlI",
        "https://example.com/not-youtube",
      ].join("\n"),
    }),
  );

  assert.match(markup, /aria-label="Choose featured video"/);
  assert.equal((markup.match(/data-video-choice=/g) || []).length, 3);
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /Video 1 of 3/);
  assert.match(markup, /Video 2 of 3/);
  assert.match(markup, /Video 3 of 3/);
  assert.match(markup, /youtube-nocookie\.com\/embed\/OklSZmIx9-o/);
  assert.doesNotMatch(markup, /playlist=/);
});

test("profile videos keep the existing empty state when no supported URL is saved", () => {
  const markup = renderToStaticMarkup(
    createElement(ProfileVideoPlayer, {
      title: "Empty featured videos",
      links: "https://example.com/video\nnot a URL",
    }),
  );

  assert.match(markup, /No featured video yet/);
  assert.doesNotMatch(markup, /<iframe/);
});

test("profile videos cap the visible selection at eight saved videos", () => {
  const links = Array.from(
    { length: 10 },
    (_, index) => `https://youtu.be/video${String(index).padStart(6, "0")}`,
  ).join(",");
  const markup = renderToStaticMarkup(
    createElement(ProfileVideoPlayer, { title: "Eight videos maximum", links }),
  );

  assert.equal((markup.match(/data-video-choice=/g) || []).length, 8);
  assert.match(markup, /Video 8 of 8/);
  assert.doesNotMatch(markup, /Video 9 of/);
});

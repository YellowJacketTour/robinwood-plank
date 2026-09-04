import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import ProfileVideoPlayer from "../../integrations/plankspace-app/app/profile-video-player";

test("profile videos use one native YouTube playlist without extra selector buttons", () => {
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

  assert.equal((markup.match(/<iframe/g) || []).length, 1);
  assert.match(markup, /youtube-nocookie\.com\/embed\/OklSZmIx9-o/);
  assert.match(markup, /playlist=7TFS8r_SMlI%2Cqmlo0F2uOGU/);
  assert.doesNotMatch(markup, /data-video-choice|profile-video-choices|<button/);
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

test("profile videos cap the native playlist at eight saved videos", () => {
  const links = Array.from(
    { length: 10 },
    (_, index) => `https://youtu.be/video${String(index).padStart(6, "0")}`,
  ).join(",");
  const markup = renderToStaticMarkup(
    createElement(ProfileVideoPlayer, { title: "Eight videos maximum", links }),
  );

  assert.equal((markup.match(/<iframe/g) || []).length, 1);
  assert.match(markup, /video000007/);
  assert.doesNotMatch(markup, /video000008|video000009|data-video-choice/);
});

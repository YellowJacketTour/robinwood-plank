import assert from "node:assert/strict";
import test from "node:test";

import { analyzeExternalWidget, sanitizeWidget } from "../../integrations/plankspace-app/app/widgets/widget-safety";
import { buildExternalWidgetDocument } from "../../integrations/plankspace-app/app/widgets/external-widget-document";
import { readFileSync } from "node:fs";

const elfsight = `<!-- Elfsight Twitter Feed -->
<script src="https://elfsightcdn.com/platform.js" async></script>
<div class="elfsight-app-1e832c7b-5eb0-421d-8c0c-b4c72b8b1888" data-elfsight-app-lazy></div>`;

test("Elfsight embed code retains its HTTPS script and reports its provider", () => {
  const result = analyzeExternalWidget(elfsight);
  assert.equal(result.errors.length, 0);
  assert.equal(result.executable, true);
  assert.deepEqual(result.origins, ["https://elfsightcdn.com"]);
  assert.match(result.source, /<script src="https:\/\/elfsightcdn\.com\/platform\.js" async><\/script>/);
});

test("external widgets reject navigation, forms, handlers, and insecure scripts", () => {
  const result = analyzeExternalWidget(`<form action="https://evil.test"><button onclick="steal()">Go</button></form><script src="http://evil.test/x.js"></script>`);
  assert.equal(result.source, "");
  assert.ok(result.errors.length >= 2);
});

test("custom widget persistence keeps analyzed source and detected origins", () => {
  const widget = sanitizeWidget({
    type: "custom",
    title: "My X feed",
    config: { source: elfsight },
    style: {},
  }, 0);
  assert.ok(widget);
  assert.equal(widget.config.executable, true);
  assert.deepEqual(widget.config.origins, ["https://elfsightcdn.com"]);
  assert.match(String(widget.config.source), /elfsightcdn\.com/);
});

test("external widget document grants network access only inside an isolated frame", () => {
  const document = buildExternalWidgetDocument({ source: elfsight, origins: ["https://elfsightcdn.com"], css: "body{color:#fff}" });
  assert.match(document, /default-src 'none'/);
  assert.match(document, /script-src https:\/\/elfsightcdn\.com/);
  assert.match(document, /connect-src https:\/\/elfsightcdn\.com/);
  assert.doesNotMatch(document, /allow-same-origin|allow-forms|allow-popups|allow-top-navigation/);
  assert.match(document, /elfsight-app-1e832c7b/);
});

test("custom widget saves are blocked until every snippet validates", async () => {
  const { widgetValidationErrors } = await import("../../integrations/plankspace-app/app/widgets/widget-safety");
  assert.deepEqual(widgetValidationErrors([{ type: "custom", config: { source: '<script src="http://bad.test/x.js"></script>' } }]), ["Widget 1: Widget scripts must use HTTPS."]);
  assert.deepEqual(widgetValidationErrors([{ type: "custom", config: { source: '<script src="https://good.test/x.js"></script>' } }]), []);
});

test("the site CSP permits the built-in chart widget providers inside profile frames", () => {
  const config = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");
  const framePolicy = config.match(/"frame-src ([^"]+)"/)?.[1] || "";

  assert.match(framePolicy, /https:\/\/dexscreener\.com/);
  assert.match(framePolicy, /https:\/\/\*\.dextools\.io/);
});

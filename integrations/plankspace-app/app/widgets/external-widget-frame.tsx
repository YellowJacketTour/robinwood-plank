"use client";

import { useMemo, useState } from "react";
import { buildExternalWidgetDocument } from "./external-widget-document";

export default function ExternalWidgetFrame({
  title,
  source,
  origins,
  css,
}: {
  title: string;
  source: string;
  origins: string[];
  css?: string;
}) {
  const [loaded, setLoaded] = useState(false),
    document = useMemo(
      () => buildExternalWidgetDocument({ source, origins, css }),
      [source, origins, css]
    );
  if (!source) return <p>This custom widget has no valid HTTPS embed code.</p>;
  if (!loaded)
    return (
      <div className="external-widget-consent">
        <b>External content is paused.</b>
        <p>
          Loading connects to{" "}
          {origins.length ? origins.join(", ") : "an external HTTPS provider"}.
          It cannot access your wallet or PlankSpace login.
        </p>
        <button type="button" onClick={() => setLoaded(true)}>
          Load external widget
        </button>
      </div>
    );
  return (
    <div className="external-widget-loaded">
      <button type="button" onClick={() => setLoaded(false)}>
        Unload external widget
      </button>
      <iframe
        className="custom-widget-frame"
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={document}
      />
    </div>
  );
}

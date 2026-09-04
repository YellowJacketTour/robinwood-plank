function escapeStyle(css: string) {
  return css.replace(/<\/style/gi, "<\\/style");
}

export function buildExternalWidgetDocument({
  source,
  origins,
  css,
}: {
  source: string;
  origins: string[];
  css?: string;
}) {
  const allowed = [
    ...new Set(origins.filter((origin) => /^https:\/\//i.test(origin))),
  ].join(" ");
  const remote = allowed ? `${allowed} https:` : "https:";
  const policy = [
    "default-src 'none'",
    `script-src ${remote}`,
    `connect-src ${remote}`,
    `img-src ${remote} data:`,
    `style-src 'unsafe-inline' ${remote}`,
    `font-src ${remote}`,
    `frame-src ${remote}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;background:transparent;color:inherit;font:inherit;overflow-wrap:anywhere}*{box-sizing:border-box}${escapeStyle(
    css || ""
  )}</style>${source}`;
}

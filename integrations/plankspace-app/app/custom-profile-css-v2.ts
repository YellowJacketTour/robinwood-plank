import { compileProfileCss } from "./customization/profile-css";

export function customProfileCss(customCss: string, legacyHtml = ""): string {
  const legacySource = legacyHtml || (/<style\b/i.test(customCss) ? customCss : "");
  const legacyCss = [...String(legacySource).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1])
    .join("\n");
  const source = legacySource === customCss ? legacyCss : customCss || legacyCss;
  return compileProfileCss(String(source)).css;
}

export function hasVisibleCustomContent(html: string): boolean {
  const markup = String(html || "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  if (!markup) return false;
  if (/<(?:img|picture|svg|canvas|video|audio|marquee|table|ul|ol|form|button|hr)\b/i.test(markup)) return true;
  return markup.replace(/<[^>]*>/g, "").replace(/&(?:nbsp|#160);/gi, "").trim().length > 0;
}

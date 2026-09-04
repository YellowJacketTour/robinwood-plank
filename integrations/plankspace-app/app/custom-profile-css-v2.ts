import { compileProfileCss } from "./customization/profile-css";

export function customProfileCss(customCss: string, legacyHtml = ""): string {
  return compileProfileCss(String(customCss || legacyHtml)).css;
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

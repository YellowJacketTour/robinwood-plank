import { compileProfileCss } from "./profile-css";

export type ProfileCustomization = {
  customCss: string;
  customHtml: string;
  compiledCss: string;
  warnings: string[];
};

const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

export function normalizeProfileCustomization(value: { customCss?: unknown; customHtml?: unknown }): ProfileCustomization {
  const legacyHtml = typeof value.customHtml === "string" ? value.customHtml.slice(0, 20_000) : "";
  const legacyCss = [...legacyHtml.matchAll(STYLE_BLOCK)].map((match) => match[1].trim()).filter(Boolean).join("\n");
  const customHtml = legacyHtml.replace(STYLE_BLOCK, "").trim();
  const customCss = (typeof value.customCss === "string" ? value.customCss : legacyCss).trim().slice(0, 24_000);

  if (/\bexport\s+(?:const|let|var|default)\b|`[\s\S]*`/.test(customCss)) {
    return { customCss, customHtml, compiledCss: "", warnings: ["Paste only CSS rules here, without export const or backticks."] };
  }

  const compiled = compileProfileCss(customCss);
  return { customCss, customHtml, compiledCss: compiled.css, warnings: compiled.warnings };
}

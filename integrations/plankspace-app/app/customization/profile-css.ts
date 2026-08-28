import postcss, { type AtRule, type Rule } from "postcss";
import selectorParser from "postcss-selector-parser";

const PROFILE_ROOT = ".classic-profile";
const MAX_SOURCE_LENGTH = 24_000;
const MAX_RULES = 300;
const PROTECTED_SELECTOR = /(?:\.plankspace-protected|\[data-plankspace-protected(?:[\]=]|$)|\.plankspace-nav|\.wallet)/i;

export type CompiledProfileCss = { css: string; warnings: string[] };

function scopedSelector(selector: string): string {
  selector = selector
    .replace(/\.plankspace-profile\b/g, ".classic-profile")
    .replace(/\.profile-columns\b/g, ".classic-profile > main")
    .replace(/\.profile-sidebar\b/g, ".classic-left")
    .replace(/\.profile-main\b/g, ".public-modules")
    .replace(/\.module-identity\b/g, ".identity")
    .replace(/\.module-contact\b/g, ".contact")
    .replace(/\.module-url\b/g, ".url")
    .replace(/\.module-interests\b/g, ".interests");
  return selectorParser((root) => {
    root.each((entry) => {
      const text = entry.toString().trim();
      if (text === ":root" || /^(?:html|body)$/i.test(text)) {
        entry.replaceWith(selectorParser.className({ value: "classic-profile" }));
        return;
      }
      if (text.startsWith(PROFILE_ROOT)) {
        entry.prepend(selectorParser.className({ value: "classic-profile" }));
        return;
      }
      entry.prepend(selectorParser.combinator({ value: " " }));
      entry.prepend(selectorParser.className({ value: "classic-profile" }));
    });
  }).processSync(selector);
}

function unsafeResource(value: string): boolean {
  if (/(?:javascript|vbscript)\s*:/i.test(value)) return true;
  for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const url = match[2].trim();
    if (!/^https:\/\//i.test(url) && !/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(url)) return true;
  }
  return false;
}

function insideKeyframes(rule: Rule): boolean {
  let parent: postcss.ChildNode["parent"] = rule.parent;
  while (parent) {
    if (parent.type === "atrule" && /keyframes$/i.test((parent as AtRule).name)) return true;
    parent = parent.parent as postcss.ChildNode["parent"];
  }
  return false;
}

export function compileProfileCss(rawSource: string): CompiledProfileCss {
  const source = String(rawSource || "").trim();
  if (!source || !source.replace(/\/\*[\s\S]*?\*\//g, "").trim()) return { css: "", warnings: [] };

  const warnings: string[] = [];
  if (source.length > MAX_SOURCE_LENGTH) {
    return { css: "", warnings: [`Custom CSS exceeds ${MAX_SOURCE_LENGTH} characters.`] };
  }

  let root: postcss.Root;
  try {
    root = postcss.parse(source);
  } catch {
    return { css: "", warnings: ["Custom CSS could not be parsed."] };
  }

  let ruleCount = 0;
  root.walkAtRules((atRule) => {
    if (!/^(?:media|supports|container|layer|keyframes|-webkit-keyframes)$/i.test(atRule.name)) {
      warnings.push(`@${atRule.name} is not allowed in profile CSS.`);
      atRule.remove();
    }
  });

  root.walkRules((rule) => {
    ruleCount += 1;
    if (ruleCount > MAX_RULES) {
      rule.remove();
      return;
    }
    if (insideKeyframes(rule)) return;
    if (PROTECTED_SELECTOR.test(rule.selector)) {
      warnings.push("A selector targeting protected PlankSpace controls was removed.");
      rule.remove();
      return;
    }

    let unsafe = false;
    rule.walkDecls((declaration) => {
      const property = declaration.prop.toLowerCase();
      const value = declaration.value;
      if (property === "position" && /^(?:fixed|sticky)$/i.test(value.trim())) {
        warnings.push(`position: ${value.trim()} is not allowed in profile CSS.`);
        unsafe = true;
      }
      if (unsafeResource(value)) {
        warnings.push("A declaration containing an unsafe URL was removed.");
        unsafe = true;
      }
      if (/^(?:behavior|-moz-binding)$/i.test(property)) unsafe = true;
    });
    if (unsafe) {
      rule.remove();
      return;
    }

    try {
      rule.selector = scopedSelector(rule.selector);
    } catch {
      warnings.push("A selector that could not be scoped was removed.");
      rule.remove();
    }
  });

  if (ruleCount > MAX_RULES) warnings.push(`Only the first ${MAX_RULES} CSS rules are allowed.`);
  return { css: root.toString().trim(), warnings };
}

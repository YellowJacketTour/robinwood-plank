"use client";

import { useCallback } from "react";
import {
  sanitizeBanner,
  sanitizeIntro,
  sanitizeLearn,
  type BannerDoc,
  type IntroDoc,
  type LearnDoc,
} from "@/lib/content-docs";
import { TOC } from "@/components/learn/LearnGuide";
import { CardChrome, useContentDocCard } from "./contentDocCard";
import { BUTTON_SECONDARY, INPUT, LABEL } from "../ui";

/**
 * Content section — the CMS override layer. Three independent cards:
 * - Learn visibility: which /learn sections render publicly. Content itself
 *   stays single-sourced in LearnGuide.tsx (no drift by construction).
 * - Intro phrases: the rotating splash lines (SplashIntro picks one per
 *   visit; the 🔨 hammer is added automatically before every headline).
 * - Banner: the site-wide announcement bar.
 */

export default function ContentSection({ address }: { address: string | null }) {
  return (
    <>
      <LearnVisibilityCard address={address} />
      <IntroPhrasesCard address={address} />
      <BannerCard address={address} />
    </>
  );
}

// --- Learn visibility ------------------------------------------------------

function LearnVisibilityCard({ address }: { address: string | null }) {
  const { doc, dirty, save, load, mutate, persist } = useContentDocCard<LearnDoc>(
    "learn",
    sanitizeLearn,
    address
  );

  const toggle = useCallback(
    (id: string) => {
      mutate((prev) => ({
        hidden: prev.hidden.includes(id)
          ? prev.hidden.filter((h) => h !== id)
          : [...prev.hidden, id],
      }));
    },
    [mutate]
  );

  return (
    <CardChrome
      title="Learn sections"
      subtitle="Show or hide /learn sections publicly"
      dirty={dirty}
      save={save}
      onReload={() => void load()}
      onSave={() => void persist()}
      canSave={!!address && doc !== null}
    >
      <p className="mt-3 text-xs text-cream-muted">
        Content stays in code (no drift) — this only controls what the public
        page renders. Hidden sections disappear from the page and its table of
        contents.
      </p>
      {doc === null ? (
        <p className="mt-3 text-sm text-cream-muted">Loading…</p>
      ) : (
        <ul className="mt-3 grid gap-1 sm:grid-cols-2">
          {TOC.map((entry) => {
            const hidden = doc.hidden.includes(entry.id);
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => toggle(entry.id)}
                  aria-pressed={!hidden}
                  className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-md border px-3 text-left text-sm transition-colors ${
                    hidden
                      ? "border-line bg-panel-strong text-cream-muted/60"
                      : "border-line bg-panel-soft text-cream hover:border-line-strong"
                  }`}
                >
                  <span className="truncate">{entry.label}</span>
                  <span
                    className={`shrink-0 text-[0.5625rem] font-black uppercase tracking-[0.12em] ${
                      hidden ? "text-rose-400" : "text-emerald-400"
                    }`}
                  >
                    {hidden ? "Hidden" : "Shown"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </CardChrome>
  );
}

// --- Intro phrases ---------------------------------------------------------

function IntroPhrasesCard({ address }: { address: string | null }) {
  const { doc, dirty, save, load, mutate, persist } = useContentDocCard<IntroDoc>(
    "intro",
    sanitizeIntro,
    address
  );

  return (
    <CardChrome
      title="Intro phrases"
      subtitle="Splash screen rotation — one is picked per visit"
      dirty={dirty}
      save={save}
      onReload={() => void load()}
      onSave={() => void persist()}
      canSave={!!address && doc !== null}
    >
      <p className="mt-3 text-xs text-cream-muted">
        The 🔨 hammer is added automatically in front of every headline. New
        phrases reach visitors on their next homepage visit (the splash reads
        a local cache so it can paint instantly).
      </p>
      {doc === null ? (
        <p className="mt-3 text-sm text-cream-muted">Loading…</p>
      ) : (
        <>
          <ol className="mt-3 space-y-3">
            {doc.phrases.map((phrase, i) => (
              <li
                key={i}
                className="rounded-md border border-line bg-panel-soft p-3"
              >
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <label className="block">
                    <span className={LABEL}>Eyebrow</span>
                    <input
                      className={`${INPUT} mt-1`}
                      value={phrase.eyebrow}
                      onChange={(e) =>
                        mutate((prev) => ({
                          phrases: prev.phrases.map((p, j) =>
                            j === i ? { ...p, eyebrow: e.target.value } : p
                          ),
                        }))
                      }
                    />
                  </label>
                  <label className="block">
                    <span className={LABEL}>Headline (🔨 auto)</span>
                    <input
                      className={`${INPUT} mt-1`}
                      value={phrase.headline}
                      onChange={(e) =>
                        mutate((prev) => ({
                          phrases: prev.phrases.map((p, j) =>
                            j === i ? { ...p, headline: e.target.value } : p
                          ),
                        }))
                      }
                    />
                  </label>
                  <button
                    type="button"
                    aria-label="Remove phrase"
                    className={`${BUTTON_SECONDARY} mt-5 w-11 px-0 text-rose-400`}
                    onClick={() =>
                      mutate((prev) => ({
                        phrases: prev.phrases.filter((_, j) => j !== i),
                      }))
                    }
                    disabled={doc.phrases.length === 1}
                  >
                    ✕
                  </button>
                  <label className="block sm:col-span-3">
                    <span className={LABEL}>Subline</span>
                    <input
                      className={`${INPUT} mt-1`}
                      value={phrase.subline}
                      onChange={(e) =>
                        mutate((prev) => ({
                          phrases: prev.phrases.map((p, j) =>
                            j === i ? { ...p, subline: e.target.value } : p
                          ),
                        }))
                      }
                    />
                  </label>
                </div>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className={`${BUTTON_SECONDARY} mt-3`}
            onClick={() =>
              mutate((prev) => ({
                phrases: [
                  ...prev.phrases,
                  {
                    eyebrow: "Warming the workshop",
                    headline: "New phrase",
                    subline: "Something funny goes here.",
                  },
                ],
              }))
            }
          >
            Add phrase
          </button>
        </>
      )}
    </CardChrome>
  );
}

// --- Banner ----------------------------------------------------------------

function BannerCard({ address }: { address: string | null }) {
  const { doc, dirty, save, load, mutate, persist } = useContentDocCard<BannerDoc>(
    "banner",
    sanitizeBanner,
    address
  );

  return (
    <CardChrome
      title="Announcement banner"
      subtitle="Site-wide notice bar above every page"
      dirty={dirty}
      save={save}
      onReload={() => void load()}
      onSave={() => void persist()}
      canSave={!!address && doc !== null}
    >
      {doc === null ? (
        <p className="mt-3 text-sm text-cream-muted">Loading…</p>
      ) : (
        <div className="mt-3 grid gap-2">
          <button
            type="button"
            onClick={() => mutate((prev) => ({ ...prev, enabled: !prev.enabled }))}
            aria-pressed={doc.enabled}
            className={`${BUTTON_SECONDARY} w-fit ${doc.enabled ? "border-gold-500/60 bg-gold-500/15" : ""}`}
          >
            {doc.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
          </button>
          <label className="block">
            <span className={LABEL}>Text</span>
            <input
              className={`${INPUT} mt-1`}
              value={doc.text}
              placeholder="e.g. Marketplank fees are 0% this weekend 🎉"
              onChange={(e) =>
                mutate((prev) => ({ ...prev, text: e.target.value }))
              }
            />
          </label>
          <label className="block">
            <span className={LABEL}>Link (optional — /path or https URL)</span>
            <input
              className={`${INPUT} mt-1 font-mono text-xs`}
              value={doc.href}
              placeholder="/market"
              onChange={(e) =>
                mutate((prev) => ({ ...prev, href: e.target.value }))
              }
              spellCheck={false}
            />
          </label>
        </div>
      )}
    </CardChrome>
  );
}

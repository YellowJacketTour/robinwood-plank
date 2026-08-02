"use client";

import { useCallback, useState } from "react";
import {
  sanitizeBanner,
  sanitizeIntro,
  sanitizeLearn,
  type BannerDoc,
  type IntroDoc,
  type LearnDoc,
} from "@/lib/content-docs";
import { TOC } from "@/components/learn/LearnGuide";
import { SkeletonBlock, SkeletonStatus } from "@/components/Skeleton";
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
  const { doc, dirty, save, load, mutate, persist, pending } = useContentDocCard<LearnDoc>(
    "learn",
    sanitizeLearn,
    address
  );
  const [editing, setEditing] = useState<string | null>(null);

  const toggle = useCallback(
    (id: string) => {
      mutate((prev) => ({
        ...prev,
        hidden: prev.hidden.includes(id)
          ? prev.hidden.filter((h) => h !== id)
          : [...prev.hidden, id],
      }));
    },
    [mutate]
  );

  const setOverride = useCallback(
    (id: string, text: string) => {
      mutate((prev) => {
        const overrides = { ...prev.overrides };
        if (text) overrides[id] = text;
        else delete overrides[id];
        return { ...prev, overrides };
      });
    },
    [mutate]
  );

  return (
    <CardChrome
      title="Learn sections"
      subtitle="Visibility + text overrides for /learn"
      dirty={dirty}
      save={save}
      onReload={() => void load()}
      onSave={() => void persist()}
      canSave={!!address && doc !== null}
    >
      <p className="mt-3 text-xs text-cream-muted">
        Each section can be shown/hidden, and its text can be overridden with
        plain text (blank line = new paragraph; no markup is interpreted).
        Sections without an override keep the coded text, and clearing an
        override restores it — the code is always the fallback, so nothing can
        drift silently.
      </p>
      {pending ? (
        <div className="mt-3">
          <SkeletonStatus>Loading Learn section visibility</SkeletonStatus>
          <div className="space-y-1">
            {TOC.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-2 rounded-md border border-line bg-panel-soft px-3 py-1.5"
              >
                <SkeletonBlock className="h-3 flex-1" />
                <SkeletonBlock className="h-8 w-20 rounded-md" />
                <SkeletonBlock className="h-8 w-20 rounded-md" />
              </div>
            ))}
          </div>
        </div>
      ) : doc === null ? null : (
        <ul className="mt-3 space-y-1">
          {TOC.map((entry) => {
            const hidden = doc.hidden.includes(entry.id);
            const override = doc.overrides[entry.id] ?? "";
            const isEditing = editing === entry.id;
            return (
              <li
                key={entry.id}
                className="rounded-md border border-line bg-panel-soft"
              >
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <span
                    className={`min-w-0 flex-1 truncate text-sm ${
                      hidden ? "text-cream-muted/60" : "text-cream"
                    }`}
                  >
                    {entry.label}
                  </span>
                  {override ? <Chip>custom text</Chip> : null}
                  <button
                    type="button"
                    onClick={() => setEditing(isEditing ? null : entry.id)}
                    className={`${BUTTON_SECONDARY} h-8 px-2 text-[0.5625rem]`}
                  >
                    {isEditing ? "Close" : "Edit text"}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggle(entry.id)}
                    aria-pressed={!hidden}
                    className={`h-8 w-20 shrink-0 rounded-md border border-line text-[0.5625rem] font-black uppercase tracking-[0.12em] ${
                      hidden ? "text-rose-400" : "text-emerald-400"
                    }`}
                  >
                    {hidden ? "Hidden" : "Shown"}
                  </button>
                </div>
                {isEditing ? (
                  <div className="border-t border-line p-3">
                    <textarea
                      className="min-h-40 w-full rounded-md border border-line bg-panel-strong p-3 text-sm text-cream placeholder:text-cream-muted/60 focus:border-line-strong focus:outline-none"
                      placeholder="Leave empty to keep the coded text. Plain text only — blank line starts a new paragraph."
                      value={override}
                      onChange={(e) => setOverride(entry.id, e.target.value)}
                    />
                    {override ? (
                      <button
                        type="button"
                        className={`${BUTTON_SECONDARY} mt-2 h-8 px-2 text-[0.5625rem] text-rose-400`}
                        onClick={() => setOverride(entry.id, "")}
                      >
                        Clear override (restore coded text)
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </CardChrome>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-gold-500/40 px-2 py-0.5 text-[0.5625rem] font-black uppercase tracking-[0.12em] text-gold-300">
      {children}
    </span>
  );
}

// --- Intro phrases ---------------------------------------------------------

function IntroPhrasesCard({ address }: { address: string | null }) {
  const { doc, dirty, save, load, mutate, persist, pending } = useContentDocCard<IntroDoc>(
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
      {pending ? (
        <div className="mt-3 space-y-3">
          <SkeletonStatus>Loading intro phrases</SkeletonStatus>
          {[0, 1].map((i) => (
            <div key={i} className="rounded-md border border-line bg-panel-soft p-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <SkeletonBlock className="h-11 w-full rounded-md" />
                <SkeletonBlock className="h-11 w-full rounded-md" />
                <SkeletonBlock className="h-11 w-11 rounded-md" />
                <SkeletonBlock className="h-11 w-full rounded-md sm:col-span-3" />
              </div>
            </div>
          ))}
        </div>
      ) : doc === null ? null : (
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
  const { doc, dirty, save, load, mutate, persist, pending } = useContentDocCard<BannerDoc>(
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
      {pending ? (
        <div className="mt-3 grid gap-2">
          <SkeletonStatus>Loading the announcement banner</SkeletonStatus>
          <SkeletonBlock className="h-11 w-48 rounded-md" />
          <SkeletonBlock className="h-11 w-full rounded-md" />
          <SkeletonBlock className="h-11 w-full rounded-md" />
        </div>
      ) : doc === null ? null : (
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

import Image from "next/image";
import type { ReactNode } from "react";

type Props = {
  eyebrow?: string;
  title: string;
  lede?: string;
  /** Optional mascot / collection art — right side on desktop, inline on mobile */
  artSrc?: string;
  artAlt?: string;
  /** Center the title/art group as a unit on desktop instead of left-aligning it */
  center?: boolean;
  /**
   * Wraps the head in the same masthead-panel treatment /trade uses
   * (TradePageHeader): wood-grain-surface + bg-panel-soft + border-line-strong
   * + a soft radial gold wash, so the headline reads as a deliberate card
   * placed in front of the giant Plank character instead of bare text
   * floating on it (DESIGN.md "Background treatment" — the character stays,
   * this just frames what sits over it). Opt-in so existing bare usages
   * (e.g. TrustFacts) are unaffected.
   */
  framed?: boolean;
  children?: ReactNode;
  className?: string;
};

/**
 * Dense section header: title + lede, optional plank art with zero wasted chrome.
 */
export default function SectionHead({
  eyebrow,
  title,
  lede,
  artSrc,
  artAlt = "",
  center = false,
  framed = false,
  children,
  className = "",
}: Props) {
  const content = (
    <div
      className={`flex flex-col items-center gap-2 sm:gap-2.5 ${
        artSrc ? `sm:flex-row sm:items-center sm:gap-4 ${center ? "sm:justify-center" : "sm:justify-start"}` : ""
      } ${framed ? "" : className}`}
    >
      <div
        className={`min-w-0 ${
          artSrc ? `sm:flex-none ${center ? "text-center sm:text-center" : "sm:text-left"}` : "text-center w-full"
        }`}
      >
        {eyebrow && (
          <p className="lede text-[0.6rem] font-extrabold uppercase tracking-[0.28em] text-gold-300/90 sm:text-[0.65rem]">
            {eyebrow}
          </p>
        )}
        <h2 className="section-title mt-0.5 text-gold-300">{title}</h2>
        {lede && (
          <p
            className={`lede mt-1 max-w-xl text-sm text-foreground/75 sm:text-base ${
              !artSrc || center ? "mx-auto text-center" : ""
            }`}
          >
            {lede}
          </p>
        )}
        {children}
      </div>
      {artSrc && (
        <div className="relative mt-0.5 hidden h-16 w-16 shrink-0 sm:mt-0 sm:block sm:h-20 sm:w-20 md:h-24 md:w-24">
          <Image
            src={artSrc}
            alt={artAlt}
            fill
            sizes="96px"
            className="object-contain drop-shadow-[0_6px_12px_rgba(0,0,0,0.5)]"
          />
        </div>
      )}
    </div>
  );

  if (!framed) return content;

  return (
    <div
      className={`wood-grain-surface relative overflow-hidden rounded-xl border border-line-strong bg-panel-soft px-4 py-6 sm:px-8 sm:py-8 ${className}`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(233,180,63,0.16),transparent_60%)]"
      />
      <div className="relative">{content}</div>
    </div>
  );
}

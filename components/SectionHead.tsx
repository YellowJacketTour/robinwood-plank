import Image from "next/image";
import type { ReactNode } from "react";

type Props = {
  eyebrow?: string;
  title: string;
  lede?: string;
  /** Optional mascot / collection art — right side on desktop, inline on mobile */
  artSrc?: string;
  artAlt?: string;
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
  children,
  className = "",
}: Props) {
  return (
    <div
      className={`flex flex-col items-center gap-2 sm:gap-2.5 ${artSrc ? "sm:flex-row sm:items-end sm:justify-between sm:gap-4" : ""} ${className}`}
    >
      <div className={`min-w-0 ${artSrc ? "sm:flex-1 sm:text-left" : "text-center w-full"}`}>
        {eyebrow && (
          <p className="lede text-[0.6rem] font-extrabold uppercase tracking-[0.28em] text-gold-300/90 sm:text-[0.65rem]">
            {eyebrow}
          </p>
        )}
        <h2 className="section-title mt-0.5 text-gold-300">{title}</h2>
        {lede && (
          <p
            className={`lede mt-1 max-w-xl text-sm text-foreground/75 sm:text-base ${artSrc ? "" : "mx-auto text-center"}`}
          >
            {lede}
          </p>
        )}
        {children}
      </div>
      {artSrc && (
        <div className="relative mt-1 h-20 w-20 shrink-0 sm:mt-0 sm:h-24 sm:w-24 md:h-28 md:w-28">
          <Image
            src={artSrc}
            alt={artAlt}
            fill
            sizes="112px"
            className="object-contain drop-shadow-[0_8px_16px_rgba(0,0,0,0.55)]"
          />
        </div>
      )}
    </div>
  );
}

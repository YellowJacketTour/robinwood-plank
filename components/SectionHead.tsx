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
      className={`flex flex-col items-center gap-2 sm:gap-2.5 ${artSrc ? "sm:flex-row sm:items-end sm:justify-start sm:gap-4" : ""} ${className}`}
    >
      <div className={`min-w-0 ${artSrc ? "sm:flex-none sm:text-left" : "text-center w-full"}`}>
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
}

"use client";

type Props = { symbol: string; size?: number; className?: string };

/** Compact vector marks for quote currencies; never falls back to a text chip. */
export default function CurrencyIcon({ symbol, size = 16, className = "" }: Props) {
  const normalized = symbol.toUpperCase();
  if (normalized === "USDC") return <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="USDC" className={className}><circle cx="16" cy="16" r="16" fill="#2775CA"/><path fill="#fff" d="M18 7.2v2c2.4.4 3.8 1.8 4.1 4h-2.8c-.2-1.1-1-1.7-2.5-1.7-1.4 0-2.3.6-2.3 1.5 0 .8.6 1.2 2 1.5l1.8.4c2.7.6 4.1 1.9 4.1 4.2 0 2.5-1.7 4.2-4.4 4.7v2h-2.3v-1.9c-2.8-.4-4.5-2-4.8-4.5h2.9c.3 1.3 1.3 2 3 2 1.6 0 2.6-.7 2.6-1.7 0-.8-.7-1.3-2.1-1.6l-1.9-.4c-2.7-.6-4-1.9-4-4.1 0-2.3 1.7-4 4.3-4.4v-2H18Z"/><path d="M8.3 6.9a11.7 11.7 0 0 0 0 18.2M23.7 6.9a11.7 11.7 0 0 1 0 18.2" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"/></svg>;
  if (normalized === "USDT") return <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="USDT" className={className}><circle cx="16" cy="16" r="16" fill="#26A17B"/><path fill="#fff" d="M7 7h18v4h-7v2.3c5 .2 8.7 1.2 8.7 2.5s-3.7 2.3-8.7 2.5V25h-4v-6.7c-5-.2-8.7-1.2-8.7-2.5s3.7-2.3 8.7-2.5V11H7V7Zm9 8.7c4.2 0 7.2-.5 7.2-1.1 0-.5-2.2-.9-5.2-1v1.2h-4v-1.2c-3 .1-5.2.5-5.2 1 0 .6 3 1.1 7.2 1.1Z"/></svg>;
  return <span aria-label={normalized} title={normalized} className={`inline-grid shrink-0 place-items-center rounded-full bg-foreground/10 font-sans text-[0.48rem] font-black text-cream-muted ${className}`} style={{ width: size, height: size }}>{normalized.slice(0, 2)}</span>;
}

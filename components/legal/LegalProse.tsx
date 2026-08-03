/**
 * Shared prose primitives for /terms and /privacy. Same visual language as
 * components/learn/LearnGuide.tsx (the site's other long-form reading
 * surface) — Uncial Antiqua section headings, Nunito Sans body, the
 * `wood-ledger` panel treatment — so the legal pages read as part of
 * RobinWood rather than a bolted-on template.
 */

export function LegalH2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="mt-14 scroll-mt-24 border-t border-line pt-7 font-display text-2xl text-gold-300 first:mt-0 first:border-t-0 first:pt-0 sm:text-[1.7rem]"
    >
      {children}
    </h2>
  );
}

export function LegalH3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-6 flex items-center gap-2 font-display text-lg text-cream">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-gold-500/70" />
      {children}
    </h3>
  );
}

export function LegalP({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[0.95rem] leading-relaxed text-cream/85">{children}</p>;
}

export function LegalUl({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-cream/85">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** A clause that has to actually hold up — plain language, no pun, visually
 * unremarkable so it reads as a normal paragraph and does not get skimmed
 * past as decoration. */
export function LegalClause({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-[0.95rem] leading-relaxed text-cream/85">{children}</p>;
}

/** Flags something the reader needs to notice, not something decorative. */
export function LegalNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-gold-500/25 border-l-[3px] border-l-gold-500/70 bg-gold-500/5 px-4 py-3 text-sm text-cream/80">
      {children}
    </div>
  );
}

export function LegalTodo({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-amber-400/40 border-l-[3px] border-l-amber-400/80 bg-amber-400/10 px-4 py-3 text-sm text-amber-50/90">
      <strong className="font-black uppercase tracking-wide">TODO:</strong> {children}
    </div>
  );
}

export function LegalHeader({
  eyebrow,
  title,
  dek,
  lastUpdated,
}: {
  eyebrow: string;
  title: string;
  dek: string;
  lastUpdated: string;
}) {
  return (
    <>
      <p className="text-[0.65rem] font-extrabold uppercase tracking-[0.2em] text-gold-400/80">
        {eyebrow}
      </p>
      <h1 className="font-display text-3xl text-gold-300 sm:text-4xl">{title}</h1>
      <LegalP>{dek}</LegalP>
      <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-cream-muted">
        Last updated: {lastUpdated}
      </p>
      <LegalNote>
        This is a plain-language summary written for a meme project, not a law firm. It is{" "}
        <strong>not legal advice</strong>, and the operator should have a lawyer review this
        document before relying on it.
      </LegalNote>
    </>
  );
}

/** Original rendered crop portraits with the official Plank head; seed/pouch controls are native vectors. */
export function CropArt({ face, seed = false }: { face: string; seed?: boolean }) {
  return <svg viewBox="0 0 100 112" aria-hidden="true" focusable="false">
    <g stroke="var(--color-wood-950)" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round">
      {seed ? <><path d="M23 21 76 17 81 91 27 96Z" fill="var(--color-cream)" /><path d="m24 33 54-4m-51 53 53-5" fill="none" /><path d="M48 70C26 44 65 36 62 56Q61 69 48 70Z" fill="var(--color-gold-500)" /></> : <>
        <image href={`/images/charmville/original/${face==="stalk"?"stalk":"splinter"}/ripe/00.png`} x="0" y="0" width="100" height="80" />
        <image href="/images/plank-head.webp" x="32" y="61" width="36" height="42" />
      </>}
    </g>
  </svg>;
}

export function PouchArt() {
  return <svg viewBox="0 0 70 70" aria-hidden="true" focusable="false"><g stroke="var(--color-wood-950)" strokeWidth="3" strokeLinejoin="round">
    <path d="m22 12 11 5 14-7-4 16q20 24 9 33-22 12-38-2-9-12 11-31Z" fill="var(--color-wood-600)" />
    <path d="m24 26 20-1m-10 2-6 18m12-19 6 17" fill="none" stroke="var(--color-gold-300)" />
    <path d="m22 48 23-3 2 13-22 2Z" fill="var(--color-gold-500)" />
  </g></svg>;
}

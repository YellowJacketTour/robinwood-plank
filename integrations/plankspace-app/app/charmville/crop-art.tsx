const CHARM_FACES = new Set(["stalk", "splinter", "knock", "hum", "pith", "gleam", "knot"]);
export function charmPortrait(face: string) {
  return charmvilleAssetFromSource(`/images/charmville/charms/${CHARM_FACES.has(face) ? face : "stalk"}.png`);
}

/** Original expressive portraits, rendered from the accompanying editable models. */
export function CropArt({ face, seed = false }: { face: string; seed?: boolean }) {
  if (!seed) return <CharmSticker face={face} celebratory/>;
  return <svg viewBox="0 0 100 112" aria-hidden="true" focusable="false">
    <g stroke="var(--color-wood-950)" strokeWidth="3.5" strokeLinejoin="round" strokeLinecap="round">
      {seed ? <><path d="M23 21 76 17 81 91 27 96Z" fill="var(--color-cream)" /><path d="m24 33 54-4m-51 53 53-5" fill="none" /><image href={charmPortrait(face)} x="25" y="31" width="54" height="54" /></> : <>
        <image href={charmPortrait(face)} x="-8" y="-2" width="116" height="116" />
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
import { CharmSticker } from "./charm-sticker";
import { charmvilleAssetFromSource } from "@/lib/charmville/content";

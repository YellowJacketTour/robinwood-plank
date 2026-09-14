/** Presentation IDs only. These confer no inventory ownership or gameplay power. */
export const FAIRY_SKINS=[['blue','Classic blue'],['gold','Warm gold'],['green','Leaf green']] as const;
export type FairySkin=typeof FAIRY_SKINS[number][0];
export const isFairySkin=(value:unknown):value is FairySkin=>FAIRY_SKINS.some(([skin])=>skin===value);

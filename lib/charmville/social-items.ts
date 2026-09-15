/** Spendable social identities, not the discovery catalogue. Adding an entry requires
 * a deployed custody schema and an accepted source/sink lifecycle first. */
export const SOCIAL_ITEMS = Object.freeze([
  Object.freeze({
    id: "oran-berry" as const,
    name: "Oran Berry",
    image: "/charmville/items/oran-berry.png",
    description: "Grown at home. Useful on your journey, or a little gift pinned to a post.",
    emptyMessage: "Harvest an Oran before pinning one",
  }),
]);

export type SocialItemId = (typeof SOCIAL_ITEMS)[number]["id"];
export const HEART_SOCIAL_ITEM = Object.freeze({id:"burning-heart" as const,name:"Burning Heart",image:"/charmville/items/burning-heart.svg",description:"A little love, grown at home. Pin one to leave a keepsake on a friend’s post.",emptyMessage:"Grow and gather a Burning Heart before pinning one"});
/** Presentation alone never enables a pin; use the authenticated enabledItems list. */
export function socialItemDefinition(value: unknown){return value===HEART_SOCIAL_ITEM.id?HEART_SOCIAL_ITEM:socialItem(value);}
export function socialItem(value: unknown) {
  return typeof value === "string" ? SOCIAL_ITEMS.find(item => item.id === value) : undefined;
}

/** Server/internal capability only; current routes and legacy clients stay Oran-only.
 * Enable only after schema, native issuance, artwork and client negotiation pass. */
export function socialCustodyItems(policy?: { burningHeart: true; clientProtocol: "social-items-v2" }) {
  return policy?.burningHeart === true && policy.clientProtocol === "social-items-v2"
    ? [...SOCIAL_ITEMS, HEART_SOCIAL_ITEM]
    : SOCIAL_ITEMS;
}

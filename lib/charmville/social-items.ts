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
export function socialItem(value: unknown) {
  return typeof value === "string" ? SOCIAL_ITEMS.find(item => item.id === value) : undefined;
}

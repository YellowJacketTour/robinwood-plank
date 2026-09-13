import {YardError} from "./errors";

export const DEFAULT_NATIVE_CROP_ID = "oran-berry";

// Only fully supported crops belong in this live registry. Inventory identity,
// growth and rewards are server-owned, never supplied in an action payload.
const oranBerry = Object.freeze({
  id: DEFAULT_NATIVE_CROP_ID,
  name: "Oran Berry",
  seedFace: "oran-berry",
  produceFace: "oran-berry",
  growthSeconds: 30,
  produceQuantity: 1,
  seedQuantity: 1,
});

export function requireNativeCrop(id: string) {
  if (id !== DEFAULT_NATIVE_CROP_ID) throw new YardError("Crop unavailable", 409);
  return oranBerry;
}

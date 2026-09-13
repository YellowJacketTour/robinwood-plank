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

// Draft alpha balance, deliberately matching Oran pacing. This definition is
// not activation: legacy callers cannot resolve or render the new crop.
export const BURNING_HEART_CROP_ID = "burning-heart";
const burningHeart = Object.freeze({
  id: BURNING_HEART_CROP_ID, name: "Burning Heart",
  seedFace: BURNING_HEART_CROP_ID, produceFace: BURNING_HEART_CROP_ID,
  growthSeconds: 30, produceQuantity: 1, seedQuantity: 1,
});
export function requireNativeCrop(id: string, options?: {burningHeartEnabled: boolean}) {
  if (id === DEFAULT_NATIVE_CROP_ID) return oranBerry;
  if (id === BURNING_HEART_CROP_ID && options?.burningHeartEnabled === true) return burningHeart;
  throw new YardError("Crop unavailable", 409);
}

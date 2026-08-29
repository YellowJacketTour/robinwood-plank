import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { siteSettings } from "../../db/schema";
import { DEFAULT_X_POST_COOLDOWN_MINUTES, normalizeXCooldownMinutes } from "./policy";

export const X_POST_COOLDOWN_SETTING = "x_post_cooldown_minutes";

export async function getXPostCooldownMinutes(): Promise<number> {
  const [row] = await getDb()
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, X_POST_COOLDOWN_SETTING))
    .limit(1);
  return row ? normalizeXCooldownMinutes(row.value) : DEFAULT_X_POST_COOLDOWN_MINUTES;
}

import type {Pool} from "pg";
import {homeActor} from "./home-access-store";
import {YardError} from "./errors";

export type TutorialPreference = {completed: boolean};
export function parseTutorialPreference(raw: unknown): TutorialPreference {
 const value = raw as Record<string, unknown> | null;
 if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.completed !== "boolean" || Object.keys(value).some(key => key !== "completed")) {
  throw new YardError("Choose whether to replay the introduction", 400);
 }
 return {completed: value.completed};
}

export async function tutorialPreference(pool: Pool, token: string, command?: TutorialPreference): Promise<TutorialPreference> {
 const client = await pool.connect();
 try {
  await client.query("BEGIN");
  const profileId = await homeActor(client, token);
  if (command !== undefined) {
   const input = parseTutorialPreference(command);
   await client.query(`INSERT INTO charmville_tutorial_preferences(profile_id,completed) VALUES($1,$2)
    ON CONFLICT(profile_id) DO UPDATE SET completed=EXCLUDED.completed,updated_at=clock_timestamp()
    WHERE charmville_tutorial_preferences.completed IS DISTINCT FROM EXCLUDED.completed`, [profileId, input.completed]);
  }
  const {rows} = await client.query("SELECT completed FROM charmville_tutorial_preferences WHERE profile_id=$1", [profileId]);
  await client.query("COMMIT");
  return {completed: rows[0]?.completed ?? false};
 } catch (error) {
  await client.query("ROLLBACK");
  throw error;
 } finally {client.release();}
}

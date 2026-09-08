import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export class YardError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export type YardAction = {
  action: "claim" | "plant" | "resolve" | "stamp" | "tend";
  requestId: string;
  plotIndex?: number;
  revision?: string;
  face?: "stalk" | "splinter";
  postId?: string;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseYardAction(raw: unknown): YardAction {
  if (!raw || typeof raw !== "object") throw new YardError("Invalid yard action", 400);
  const p = raw as Record<string, unknown>;
  if (!uuid.test(String(p.requestId)) || !["claim", "plant", "resolve", "stamp", "tend"].includes(String(p.action)))
    throw new YardError("Invalid yard action", 400);
  const action = p.action as YardAction["action"];
  const result: YardAction = { action, requestId: String(p.requestId) };
  if (["plant", "resolve", "tend"].includes(action)) {
    if (!Number.isInteger(p.plotIndex) || Number(p.plotIndex) < 0 || Number(p.plotIndex) > 5 || !/^\d+$/.test(String(p.revision)))
      throw new YardError("Choose a current plot", 400);
    result.plotIndex = Number(p.plotIndex); result.revision = String(p.revision);
  }
  if (action === "plant") {
    if (p.face !== "stalk" && p.face !== "splinter") throw new YardError("Choose Stalk or Splinter", 400);
    result.face = p.face;
  }
  if (action === "stamp") {
    if (!/^[1-9]\d{0,17}$/.test(String(p.postId))) throw new YardError("Choose a Grain", 400);
    result.postId = String(p.postId);
  }
  return result;
}

async function actor(client: PoolClient, token: string) {
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new YardError("Sign in to tend your porch", 401);
  const hash = digest(token);
  const { rows } = await client.query(`SELECT p.id::text, p.wallet FROM plankspace_wallet_sessions s
    JOIN plankspace_profiles p ON lower(p.wallet)=lower(s.wallet)
    WHERE s.token_hash=$1 AND s.expires_at::timestamptz > clock_timestamp()
    AND p.moderation_status='approved' FOR SHARE OF s`, [hash]);
  if (!rows[0]) throw new YardError("Your session expired. Sign in again; your porch is safe.", 401);
  return { ...rows[0], hash } as { id: string; wallet: string; hash: string };
}

async function snapshot(client: PoolClient, profileId: string, owner: boolean) {
  const yard = await client.query("SELECT revision::text, land_value::text FROM charmville_yards WHERE profile_id=$1", [profileId]);
  const plots = await client.query(`SELECT plot_index AS "plotIndex", crop, ripe_at AS "ripeAt",
    compost_after AS "compostAfter", revision::text, tilled,
    EXISTS(SELECT 1 FROM charmville_receipts r WHERE r.cycle_id=charmville_plots.cycle_id AND r.action='tend') AS tended
    FROM charmville_plots WHERE profile_id=$1 ORDER BY plot_index`, [profileId]);
  const stamps = await client.query(`SELECT post_id::text AS "postId",sum(qty)::text AS qty
    FROM charmville_stamps WHERE profile_id=$1 GROUP BY post_id`, [profileId]);
  let inventory = null;
  if (owner && yard.rowCount) {
    const seeds = await client.query("SELECT face_id AS face, qty::text FROM charmville_seeds WHERE profile_id=$1 ORDER BY face_id", [profileId]);
    const faces = await client.query("SELECT face_id AS face, qty::text FROM charmville_stacks WHERE profile_id=$1 ORDER BY face_id", [profileId]);
    const grain = await client.query("SELECT grain::text FROM charmville_yards WHERE profile_id=$1", [profileId]);
    inventory = { seeds: seeds.rows, faces: faces.rows, grain: grain.rows[0].grain };
  }
  const now = await client.query("SELECT clock_timestamp() AS now");
  return { claimed: !!yard.rowCount, owner, plots: plots.rows.map(plot => ({
    ...plot, ripeAt: plot.ripeAt?.toISOString() ?? null,
    compostAfter: plot.compostAfter?.toISOString() ?? null,
  })), inventory, stamps: stamps.rows, serverNow: now.rows[0].now.toISOString() as string };
}

export async function readYard(pool: Pool, handle: string, token = "") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows } = await client.query("SELECT id::text, wallet FROM plankspace_profiles WHERE handle=$1 AND moderation_status='approved'", [handle]);
    if (!rows[0]) throw new YardError("Board not found", 404);
    let owner = false;
    if (/^[a-f0-9]{64}$/i.test(token)) {
      const session = await client.query(`SELECT 1 FROM plankspace_wallet_sessions WHERE token_hash=$1
        AND lower(wallet)=lower($2) AND expires_at::timestamptz > clock_timestamp()`, [digest(token), rows[0].wallet]);
      owner = !!session.rowCount;
    }
    const result = await snapshot(client, rows[0].id, owner);
    await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function mutateYard(pool: Pool, handle: string, token: string, input: YardAction) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const who = await actor(client, token);
    const target = await client.query("SELECT id::text FROM plankspace_profiles WHERE handle=$1 AND moderation_status='approved'", [handle]);
    if (!target.rows[0]) throw new YardError("Board not found", 404);
    const profileId: string = target.rows[0].id;
    if (input.action !== "tend" && who.id !== profileId) throw new YardError("This porch belongs to another board", 403);
    if (input.action === "tend" && who.id === profileId) throw new YardError("Visit a neighbor to tend", 400);
    // Serializes each actor's request ids and both yards, including first claims.
    await client.query("SELECT id FROM plankspace_profiles WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE", [[who.id, profileId]]);
    const payloadHash = digest(JSON.stringify({ handle, ...input }));
    const prior = await client.query("SELECT payload_hash, result FROM charmville_receipts WHERE actor_profile_id=$1 AND request_id=$2", [who.id, input.requestId]);
    if (prior.rows[0]) {
      if (prior.rows[0].payload_hash !== payloadHash) throw new YardError("Request id already used for a different action");
      await client.query("COMMIT"); return prior.rows[0].result;
    }
    const receiptId = randomUUID();
    let receiptAction: string = input.action;
    let face: string | null = input.face ?? null;
    let qty = 0, seedDelta = 0, grainDelta = 0;
    let cycleId: string | null = null;
    if (input.action === "claim") {
      const created = await client.query("INSERT INTO charmville_yards(profile_id,grain) VALUES($1,2) ON CONFLICT DO NOTHING RETURNING profile_id", [profileId]);
      if (!created.rowCount) throw new YardError("Your porch is already claimed");
      await client.query(`INSERT INTO charmville_plots(profile_id,plot_index,crop,cycle_id,planted_at,ripe_at,compost_after)
        SELECT $1,n,CASE WHEN n<2 THEN 'stalk' END,CASE WHEN n<2 THEN CASE WHEN n=0 THEN $2::uuid ELSE $3::uuid END END,
        CASE WHEN n<2 THEN CURRENT_TIMESTAMP-INTERVAL '4 hours' END,
        CASE WHEN n<2 THEN CURRENT_TIMESTAMP END,CASE WHEN n<2 THEN CURRENT_TIMESTAMP+INTERVAL '48 hours' END
        FROM generate_series(0,5) n`, [profileId, randomUUID(), randomUUID()]);
      await client.query("INSERT INTO charmville_seeds(profile_id,face_id,qty) VALUES($1,'stalk',2),($1,'splinter',1)", [profileId]);
      grainDelta = 2;
    } else {
      const yard = await client.query("SELECT profile_id FROM charmville_yards WHERE profile_id=$1", [profileId]);
      if (!yard.rowCount) throw new YardError("Claim your porch first");
      if (input.action === "stamp") {
        const post = await client.query("SELECT id FROM plankspace_posts WHERE id=$1 AND lower(author_wallet)=lower($2) AND moderation_status='approved' FOR SHARE", [input.postId, who.wallet]);
        if (!post.rowCount) throw new YardError("Choose one of your published Grains", 403);
        const debit = await client.query("UPDATE charmville_stacks SET qty=qty-1 WHERE profile_id=$1 AND face_id='stalk' AND qty>=1 RETURNING qty", [profileId]);
        if (!debit.rowCount) throw new YardError("Grow a Stalk before stamping");
        face = "stalk"; qty = 1;
      } else {
        const row = await client.query("SELECT *, ripe_at<=clock_timestamp() AS ready, compost_after<=clock_timestamp() AS expired FROM charmville_plots WHERE profile_id=$1 AND plot_index=$2 FOR UPDATE", [profileId, input.plotIndex]);
        const plot = row.rows[0];
        if (!plot || String(plot.revision) !== input.revision) throw new YardError("This plot changed. Refresh your porch.");
        if (input.action === "plant") {
          if (plot.crop || !plot.tilled) throw new YardError("Choose an empty tilled plot");
          const spent = await client.query("UPDATE charmville_seeds SET qty=qty-1 WHERE profile_id=$1 AND face_id=$2 AND qty>=1 RETURNING qty", [profileId, face]);
          if (!spent.rowCount) throw new YardError("You need that seed");
          grainDelta = face === "splinter" ? -2 : 0; seedDelta = -1; cycleId = randomUUID();
          const paid = await client.query("UPDATE charmville_yards SET grain=grain+$2 WHERE profile_id=$1 AND grain+$2>=0 RETURNING grain", [profileId, grainDelta]);
          if (!paid.rowCount) throw new YardError("Splinter needs 2 grain. Stalk needs only its seed.");
          await client.query(`UPDATE charmville_plots SET crop=$3,cycle_id=$4,planted_at=CURRENT_TIMESTAMP,
            ripe_at=CURRENT_TIMESTAMP+($5*INTERVAL '1 hour'),compost_after=CURRENT_TIMESTAMP+(($5+48)*INTERVAL '1 hour'),
            revision=revision+1 WHERE profile_id=$1 AND plot_index=$2`, [profileId, input.plotIndex, face, cycleId, face === "stalk" ? 4 : 16]);
        } else if (input.action === "resolve") {
          if (!plot.crop || !plot.ready) throw new YardError("This crop is still growing");
          face = plot.crop; cycleId = plot.cycle_id; seedDelta = 1;
          receiptAction = plot.expired ? "compost" : "harvest"; qty = plot.expired ? 0 : 3; grainDelta = plot.expired ? 0 : 1;
          await client.query("INSERT INTO charmville_seeds(profile_id,face_id,qty) VALUES($1,$2,1) ON CONFLICT(profile_id,face_id) DO UPDATE SET qty=charmville_seeds.qty+1", [profileId, face]);
          if (qty) await client.query("INSERT INTO charmville_stacks(profile_id,face_id,qty) VALUES($1,$2,$3) ON CONFLICT(profile_id,face_id) DO UPDATE SET qty=charmville_stacks.qty+EXCLUDED.qty", [profileId, face, qty]);
          await client.query("UPDATE charmville_yards SET grain=grain+$2 WHERE profile_id=$1", [profileId, grainDelta]);
          await client.query("UPDATE charmville_plots SET crop=NULL,cycle_id=NULL,planted_at=NULL,ripe_at=NULL,compost_after=NULL,revision=revision+1 WHERE profile_id=$1 AND plot_index=$2", [profileId, input.plotIndex]);
        } else {
          if (!plot.crop || plot.ready) throw new YardError("Choose a neighbor's growing crop");
          const own = await client.query("SELECT profile_id FROM charmville_yards WHERE profile_id=$1", [who.id]);
          if (!own.rowCount) throw new YardError("Claim your own porch before tending");
          const cap = await client.query("SELECT count(*)::int AS n, bool_or(target_profile_id=$2) AS visited FROM charmville_tends WHERE actor_profile_id=$1 AND day_utc=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date", [who.id, profileId]);
          if (cap.rows[0].n >= 5 || cap.rows[0].visited) throw new YardError("Your tending allowance for this visit is used");
          grainDelta = 1; face = plot.crop; cycleId = plot.cycle_id;
          await client.query("UPDATE charmville_yards SET grain=grain+1 WHERE profile_id=$1", [who.id]);
          // Insert tend after its receipt below (FK). Slot is stable under actor profile lock.
        }
      }
      await client.query("UPDATE charmville_yards SET revision=revision+1 WHERE profile_id=$1", [profileId]);
    }
    const result = { action: receiptAction, receiptId, qty, ...(await snapshot(client, profileId, who.id === profileId)) };
    await client.query(`INSERT INTO charmville_receipts(id,profile_id,action,request_id,payload_hash,actor_profile_id,
      actor_wallet,session_hash,plot_index,cycle_id,face_id,qty,seed_delta,grain_delta,result)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [receiptId,profileId,receiptAction,input.requestId,payloadHash,who.id,who.wallet,who.hash,input.plotIndex ?? null,cycleId,face,qty,seedDelta,grainDelta,JSON.stringify(result)]);
    if (input.action === "stamp") await client.query("INSERT INTO charmville_stamps(receipt_id,profile_id,post_id,face_id,qty) VALUES($1,$2,$3,'stalk',1)", [receiptId,profileId,input.postId]);
    if (input.action === "tend") await client.query(`INSERT INTO charmville_tends(receipt_id,actor_profile_id,target_profile_id,plot_index,day_utc,reward_slot)
      SELECT $1,$2,$3,$4,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,count(*)+1 FROM charmville_tends
      WHERE actor_profile_id=$2 AND day_utc=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`, [receiptId,who.id,profileId,input.plotIndex]);
    await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

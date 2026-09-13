import {requireCharmvilleAdmission} from './admission';
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { YardError } from "./errors";
import { SOCIAL_ITEMS, socialItem } from "./social-items";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function parseSocialPin(raw: unknown) {
  const p = raw as Record<string, unknown> | null;
  const item = socialItem(p?.face);
  if (!p || !item || !/^[1-9]\d{0,17}$/.test(String(p.postId)) ||
      !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(String(p.requestId)))
    throw new YardError("Choose an owned Oran and a current post", 400);
  return { postId: String(p.postId), face: item.id, requestId: String(p.requestId) };
}
// Same approved-post and bidirectional block scope as reputation discovery.
const eligible = `p.moderation_status='approved' AND a.moderation_status='approved'
 AND NOT EXISTS (SELECT 1 FROM plankspace_profile_relations b WHERE b.kind='block'
 AND ((lower(b.owner_wallet)=lower(v.wallet) AND b.target_handle=a.handle)
 OR (lower(b.owner_wallet)=lower(a.wallet) AND b.target_handle=v.handle)))`;

export async function charmSocial(pool: Pool, token: string, raw?: unknown) {
  const pin = raw === undefined ? null : parseSocialPin(raw);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (!/^[a-f0-9]{64}$/i.test(token)) throw new YardError("Sign in to open Charmdex",401);
    const session = (await c.query(`SELECT p.id::text FROM plankspace_wallet_sessions s
      JOIN plankspace_profiles p ON lower(p.wallet)=lower(s.wallet)
      WHERE s.token_hash=$1 AND s.expires_at::timestamptz>clock_timestamp()
      AND p.moderation_status='approved' FOR SHARE OF s`,[hash(token)])).rows[0];
    if (!session) throw new YardError("Your session expired. Sign in again.",401);
    const id: string = session.id;
    await requireCharmvilleAdmission(c,id);
    // Same actor lock and receipt namespace used by yard mutations. No second balance.
    const actor = (await c.query("SELECT wallet FROM plankspace_profiles WHERE id=$1 AND moderation_status='approved' FOR UPDATE", [id])).rows[0];
    if (!actor) throw new YardError("Your profile is unavailable",403);
    if (pin) {
      const payloadHash = hash(JSON.stringify({ domain: "social-pin", ...pin }));
      const prior = (await c.query("SELECT payload_hash,result FROM charmville_receipts WHERE actor_profile_id=$1 AND request_id=$2", [id,pin.requestId])).rows[0];
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new YardError("Request id already used for a different action",409);
        await c.query("COMMIT"); return prior.result;
      }
      const post = await c.query(`SELECT p.id FROM plankspace_posts p
        JOIN plankspace_profiles a ON lower(a.wallet)=lower(p.author_wallet)
        JOIN plankspace_profiles v ON v.id=$1 WHERE p.id=$2 AND ${eligible} FOR SHARE OF p`, [id,pin.postId]);
      if (!post.rowCount) throw new YardError("This post is unavailable for pinning",403);
      const debit = await c.query("UPDATE charmville_stacks SET qty=qty-1 WHERE profile_id=$1 AND face_id=$2 AND qty>=1 RETURNING qty::text",[id,pin.face]);
      if (!debit.rowCount) throw new YardError(socialItem(pin.face)!.emptyMessage,409);
      const receiptId = randomUUID();
      const result = { receiptId, postId:pin.postId, face:pin.face, qty:1, remaining:debit.rows[0].qty };
      await c.query(`INSERT INTO charmville_receipts(id,profile_id,action,request_id,payload_hash,actor_profile_id,actor_wallet,session_hash,face_id,qty,result)
        VALUES($1,$2,'stamp',$3,$4,$2,$5,$6,$8,1,$7::jsonb)`,[receiptId,id,pin.requestId,payloadHash,actor.wallet,hash(token),JSON.stringify(result),pin.face]);
      await c.query("INSERT INTO charmville_stamps(receipt_id,profile_id,post_id,face_id,qty) VALUES($1,$2,$3,$4,1)",[receiptId,id,pin.postId,pin.face]);
      await c.query("UPDATE charmville_yards SET revision=revision+1 WHERE profile_id=$1",[id]);
      await c.query("COMMIT"); return result;
    }
    const posts = await c.query(`SELECT p.id::text,p.body,a.handle AS "authorHandle",a.display_name AS "authorName",p.created_at AS "createdAt",
      COALESCE((SELECT sum(s.qty) FROM charmville_stamps s WHERE s.post_id=p.id AND s.face_id='oran-berry'),0)::text AS "oranPins",
      COALESCE((SELECT jsonb_object_agg(t.face_id,t.qty) FROM
        (SELECT s.face_id,sum(s.qty)::text AS qty FROM charmville_stamps s
         WHERE s.post_id=p.id AND s.face_id=ANY($2::text[]) GROUP BY s.face_id) t),'{}'::jsonb) AS pins
      FROM plankspace_posts p JOIN plankspace_profiles a ON lower(a.wallet)=lower(p.author_wallet)
      JOIN plankspace_profiles v ON v.id=$1 WHERE ${eligible} ORDER BY p.id DESC LIMIT 30`,[id,SOCIAL_ITEMS.map(item => item.id)]);
    const balances = (await c.query("SELECT face_id,qty::text FROM charmville_stacks WHERE profile_id=$1 AND face_id=ANY($2::text[])",[id,SOCIAL_ITEMS.map(item => item.id)])).rows;
    await c.query("COMMIT");
    return { posts:posts.rows, basket:SOCIAL_ITEMS.map(item => ({face:item.id,qty:balances.find(row => row.face_id === item.id)?.qty ?? "0"})) };
  } catch (error) { await c.query("ROLLBACK"); throw error; }
  finally { c.release(); }
}

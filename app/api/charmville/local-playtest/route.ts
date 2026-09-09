import { randomBytes, createHash } from "node:crypto";
import { postgresPool } from "@/lib/postgres";
import { localPlaytestRequestAllowed } from "@/lib/charmville/local-playtest-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  if (!localPlaytestRequestAllowed(request, process.env)) return Response.json({error:"Not found"},{status:404,headers});
  const wallet = "0x" + randomBytes(20).toString("hex");
  const token = randomBytes(32).toString("hex");
  const handle = "local_demo_" + randomBytes(6).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
  const client = await postgresPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO plankspace_profiles(wallet,handle,display_name,moderation_status,layout_json)
      VALUES($1,$2,'Your Charmville board','approved','["feed","friends"]')`, [wallet,handle]);
    await client.query(`INSERT INTO plankspace_wallet_sessions(token_hash,wallet,expires_at) VALUES($1,$2,$3)`,
      [createHash("sha256").update(token).digest("hex"),wallet,expiresAt]);
    const post = await client.query(`INSERT INTO plankspace_posts(author,author_wallet,body)
      VALUES('Your Charmville board',$1,'My first harvest. A little Stalk from my corner of the Lumberyard.') RETURNING id,body`, [wallet]);
    await client.query("COMMIT");
    return Response.json({wallet,token,handle,expiresAt,posts:post.rows},{headers});
  } catch {
    await client.query("ROLLBACK");
    return Response.json({error:"The local garden could not open. Please try again."},{status:503,headers});
  } finally { client.release(); }
}

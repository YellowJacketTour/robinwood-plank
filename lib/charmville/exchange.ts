import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { YardError } from './errors';

// Current durable Satchel definitions. Catalogue discovery is not spendable supply.
export const EXCHANGE_FACES = ['stalk','splinter','knock','hum','pith','gleam','knot','oran-berry'] as const;
type Command = { kind:'create'|'fill'|'cancel'; requestId:string; offerId?:string; side?:'buy'|'sell'; face?:string; quantity?:string; price?:string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (s:string) => createHash('sha256').update(s).digest('hex');
export function parseExchangeCommand(raw:unknown):Command {
 const p=raw as Record<string,unknown>;
 if(!p || typeof p!=='object' || !['create','fill','cancel'].includes(String(p.kind)) || typeof p.requestId!=='string' || !uuid.test(p.requestId)) throw new YardError('Invalid exchange request',400);
 const result:Command={kind:p.kind as Command['kind'],requestId:p.requestId};
 const quantity=(v:unknown,max:bigint)=>{if(typeof v!=='string'||!/^[1-9]\d{0,9}$/.test(v)||BigInt(v)>max)throw new YardError('Choose a valid whole quantity',400);return v;};
 if(result.kind!=='cancel') result.quantity=quantity(p.quantity,1000000n);
 if(result.kind==='create') {
  if(p.side!=='buy'&&p.side!=='sell')throw new YardError('Choose buy or sell',400);
  if(typeof p.face!=='string'||!EXCHANGE_FACES.includes(p.face as typeof EXCHANGE_FACES[number]))throw new YardError('This charm is not tradable yet',400);
  result.side=p.side;result.face=p.face;result.price=quantity(p.price,1000000000n);
 }else{if(typeof p.offerId!=='string'||!uuid.test(p.offerId))throw new YardError('Choose an offer',400);result.offerId=p.offerId;}
 return result;
}
async function actor(client:PoolClient,token:string){
 if(!/^[a-f0-9]{64}$/i.test(token))throw new YardError('Sign in to trade',401);
 const r=await client.query(`SELECT p.id::text FROM plankspace_wallet_sessions s JOIN plankspace_profiles p ON lower(p.wallet)=lower(s.wallet)
 WHERE s.token_hash=$1 AND s.expires_at::timestamptz>clock_timestamp() AND p.moderation_status='approved' FOR SHARE OF s`,[hash(token)]);
 if(!r.rowCount)throw new YardError('Sign in to trade',401);return r.rows[0].id as string;
}
async function grain(client:PoolClient,id:string,delta:bigint){
 const r=await client.query('UPDATE charmville_yards SET grain=grain+$2 WHERE profile_id=$1 AND grain+$2>=0 RETURNING profile_id',[id,delta.toString()]);
 if(!r.rowCount)throw new YardError('Not enough Grain, or no claimed garden');
}
async function charms(client:PoolClient,id:string,face:string,delta:bigint){
 if(delta<0n){const r=await client.query('UPDATE charmville_stacks SET qty=qty+$3 WHERE profile_id=$1 AND face_id=$2 AND qty+$3>=0 RETURNING profile_id',[id,face,delta.toString()]);if(!r.rowCount)throw new YardError('Not enough charms');}
 else await client.query('INSERT INTO charmville_stacks(profile_id,face_id,qty) VALUES($1,$2,$3) ON CONFLICT(profile_id,face_id) DO UPDATE SET qty=charmville_stacks.qty+EXCLUDED.qty',[id,face,delta.toString()]);
}
export async function exchangeCommand(pool:Pool,token:string,raw:unknown){
 const input=parseExchangeCommand(raw),client=await pool.connect();
 try{
  await client.query('BEGIN');const actorId=await actor(client,token);
  // Resolve immutable offer owner before locking profiles in global order.
  let ownerId=actorId;
  if(input.offerId){const r=await client.query('SELECT owner_profile_id::text FROM charmville_offers WHERE id=$1',[input.offerId]);if(!r.rowCount)throw new YardError('Offer not found',404);ownerId=r.rows[0].owner_profile_id;}
  const parties=[...new Set([actorId,ownerId])];
  const locked=await client.query("SELECT id FROM plankspace_profiles WHERE id=ANY($1::bigint[]) AND moderation_status='approved' ORDER BY id FOR UPDATE",[parties]);
  if(locked.rowCount!==parties.length)throw new YardError('Trading account unavailable',403);
  const fingerprint=hash(JSON.stringify(input));
  const prior=await client.query('SELECT payload_hash,result FROM charmville_exchange_receipts WHERE actor_profile_id=$1 AND request_id=$2',[actorId,input.requestId]);
  if(prior.rowCount){if(prior.rows[0].payload_hash!==fingerprint)throw new YardError('Request already used');await client.query('COMMIT');return prior.rows[0].result;}
  const homes=await client.query('SELECT profile_id FROM charmville_yards WHERE profile_id=ANY($1::bigint[])',[parties]);
  if(homes.rowCount!==parties.length)throw new YardError('Claim your garden before trading');
  let offerId=input.offerId,amount=0n,cost=0n;
  if(input.kind==='create'){
   amount=BigInt(input.quantity!);cost=amount*BigInt(input.price!);
   // No matching or price guarantees: this creates an explicitly accepted fixed-price offer.
   if(input.side==='buy')await grain(client,actorId,-cost);else await charms(client,actorId,input.face!,-amount);
   offerId=randomUUID();await client.query('INSERT INTO charmville_offers(id,owner_profile_id,side,face_id,price,remaining) VALUES($1,$2,$3,$4,$5,$6)',[offerId,actorId,input.side,input.face,input.price,input.quantity]);
  }else{
   const r=await client.query('SELECT side,face_id,price::text,remaining::text,state FROM charmville_offers WHERE id=$1 FOR UPDATE',[offerId]);const offer=r.rows[0];
   if(offer.state!=='open')throw new YardError('This offer is closed');
   if(input.kind==='cancel'){
    if(actorId!==ownerId)throw new YardError('Only the owner can cancel',403);
    amount=BigInt(offer.remaining);cost=amount*BigInt(offer.price);
    if(offer.side==='buy')await grain(client,ownerId,cost);else await charms(client,ownerId,offer.face_id,amount);
    await client.query("UPDATE charmville_offers SET state='cancelled' WHERE id=$1",[offerId]);
   }else{
    if(actorId===ownerId)throw new YardError('Choose another player’s offer',400);
    amount=BigInt(input.quantity!);if(amount>BigInt(offer.remaining))throw new YardError('Offer quantity changed');cost=amount*BigInt(offer.price);
    if(offer.side==='sell'){await grain(client,actorId,-cost);await grain(client,ownerId,cost);await charms(client,actorId,offer.face_id,amount);}
    else{await charms(client,actorId,offer.face_id,-amount);await charms(client,ownerId,offer.face_id,amount);await grain(client,actorId,cost);}
    await client.query("UPDATE charmville_offers SET remaining=remaining-$2,state=CASE WHEN remaining=$2 THEN 'filled' ELSE 'open' END WHERE id=$1",[offerId,amount.toString()]);
   }
  }
  const result={action:input.kind,offerId,quantity:amount.toString(),grain:cost.toString()};
  await client.query('INSERT INTO charmville_exchange_receipts(actor_profile_id,request_id,payload_hash,offer_id,action,quantity,grain,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[actorId,input.requestId,fingerprint,offerId,input.kind,amount.toString(),cost.toString(),JSON.stringify(result)]);
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function readExchange(pool:Pool){
 const client=await pool.connect();
 try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const {rows}=await client.query(`SELECT o.id,p.handle AS owner,o.side,o.face_id AS face,o.price::text,o.remaining::text,o.created_at AS "createdAt"
 FROM charmville_offers o JOIN plankspace_profiles p ON p.id=o.owner_profile_id WHERE o.state='open' AND p.moderation_status='approved' ORDER BY o.created_at,o.id LIMIT 100`);
 const totals=await client.query(`SELECT r.grain::text AS reserve,r.opening_supply::text AS "openingSupply",
 COALESCE((SELECT SUM(grain) FROM charmville_yards),0)::text AS circulating,
 COALESCE((SELECT SUM(price::numeric*remaining) FROM charmville_offers WHERE side='buy' AND state='open'),0)::text AS escrow
 FROM charmville_grain_reserve r WHERE id=1`);
 await client.query('COMMIT');return {offers:rows,definitions:EXCHANGE_FACES,kind:'fixed-price-offers',grainSupply:totals.rows[0]??null};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

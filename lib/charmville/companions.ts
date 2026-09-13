import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import catalogue from "../../public/charmville/catalog/species-catalog.json";
import {homeActor} from "./home-access-store";
import {YardError} from "./errors";
export const COMPANION_CHOICES=catalogue.species.filter(s=>["SPECIES_TREECKO","SPECIES_TORCHIC","SPECIES_MUDKIP"].includes(s.symbol)).map(s=>{if(!s.sourceName)throw new Error("Missing source starter name");return {speciesId:s.sourceSpeciesId,sourceName:s.sourceName,sprite:`/charmville/creatures/${s.sourceName.toLowerCase()}-front.png`};});
export function parseCompanionChoice(raw:unknown):number {
 const p=raw as Record<string,unknown>|null;
 if(!p||!Number.isInteger(p.speciesId)||!COMPANION_CHOICES.some(c=>c.speciesId===p.speciesId))throw new YardError("Choose an available starter companion",400);
 return p.speciesId as number;
}
export type FollowingCommand={action:"following";companionId:string;following:boolean;revision:string};
export function parseCompanionCommand(raw:unknown):number|FollowingCommand {
 const p=raw as Record<string,unknown>|null;
 if(!p||typeof p!=="object")throw new YardError("Invalid companion action",400);
 if(p.action===undefined)return parseCompanionChoice(p);
 if(p.action!=="following"||typeof p.companionId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.companionId)||typeof p.following!=="boolean"||typeof p.revision!=="string"||!/^\d{1,18}$/.test(p.revision))throw new YardError("Invalid following preference",400);
 return {action:"following",companionId:p.companionId,following:p.following,revision:p.revision};
}
export async function companions(pool:Pool,token:string,command?:number|FollowingCommand){
 const client=await pool.connect();
 try{
  await client.query("BEGIN");const profileId=await homeActor(client,token);
  const speciesId=typeof command==="number"?command:undefined;
  if(speciesId!==undefined){
   parseCompanionChoice({speciesId});
   const home=await client.query("SELECT profile_id FROM charmville_yards WHERE profile_id=$1 FOR SHARE",[profileId]);if(!home.rowCount)throw new YardError("Claim your home before choosing a companion",409);
   const choice=COMPANION_CHOICES.find(c=>c.speciesId===speciesId)!;
   await client.query("INSERT INTO charmville_companions(id,owner_profile_id,source_species_id,nickname) VALUES($1,$2,$3,$4) ON CONFLICT(owner_profile_id) DO NOTHING",[randomUUID(),profileId,speciesId,choice.sourceName]);
  }
  if(typeof command==="object"){
   const input=parseCompanionCommand(command) as FollowingCommand;
   const owned=await client.query("SELECT following,revision::text FROM charmville_companions WHERE owner_profile_id=$1 AND id=$2 FOR UPDATE",[profileId,input.companionId]);
   if(!owned.rowCount)throw new YardError("Companion not found",404);
   const current=owned.rows[0];
   // Absolute repeated preference is harmless; never replay a toggle. A stale
   // request that would change a newer value must reload instead.
   if(BigInt(input.revision)>BigInt(current.revision)||(input.revision!==current.revision&&input.following!==current.following))throw new YardError("Your companion changed. Refresh before updating.",409);
   if(input.following!==current.following)await client.query("UPDATE charmville_companions SET following=$2,revision=revision+1 WHERE id=$1",[input.companionId,input.following]);
  }
  const result=await client.query(`SELECT id,source_species_id AS "speciesId",nickname,created_at AS "createdAt",following,revision::text FROM charmville_companions WHERE owner_profile_id=$1`,[profileId]);
  const record=result.rows[0];
  const homeClaimed=(await client.query("SELECT EXISTS(SELECT 1 FROM charmville_yards WHERE profile_id=$1) AS claimed",[profileId])).rows[0].claimed as boolean;
  if(speciesId!==undefined&&record.speciesId!==speciesId)throw new YardError("Your starter companion is already chosen",409);
  const choice=record?COMPANION_CHOICES.find(c=>c.speciesId===record.speciesId):undefined;
  await client.query("COMMIT");
  const companion=record?{...record,sourceName:choice!.sourceName,sprite:choice!.sprite,createdAt:record.createdAt.toISOString()}:null;
  return {homeClaimed,companion,party:companion?[companion]:[],following:companion?.following??false,choices:COMPANION_CHOICES};
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}

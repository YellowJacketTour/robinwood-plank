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
export async function companions(pool:Pool,token:string,speciesId?:number){
 const client=await pool.connect();
 try{
  await client.query("BEGIN");const profileId=await homeActor(client,token);
  if(speciesId!==undefined){
   parseCompanionChoice({speciesId});
   const home=await client.query("SELECT profile_id FROM charmville_yards WHERE profile_id=$1 FOR SHARE",[profileId]);if(!home.rowCount)throw new YardError("Claim your home before choosing a companion",409);
   const choice=COMPANION_CHOICES.find(c=>c.speciesId===speciesId)!;
   await client.query("INSERT INTO charmville_companions(id,owner_profile_id,source_species_id,nickname) VALUES($1,$2,$3,$4) ON CONFLICT(owner_profile_id) DO NOTHING",[randomUUID(),profileId,speciesId,choice.sourceName]);
  }
  const result=await client.query(`SELECT id,source_species_id AS "speciesId",nickname,created_at AS "createdAt" FROM charmville_companions WHERE owner_profile_id=$1`,[profileId]);
  const record=result.rows[0];
  if(speciesId!==undefined&&record.speciesId!==speciesId)throw new YardError("Your starter companion is already chosen",409);
  const choice=record?COMPANION_CHOICES.find(c=>c.speciesId===record.speciesId):undefined;
  await client.query("COMMIT");
  return {companion:record?{...record,sourceName:choice!.sourceName,sprite:choice!.sprite,createdAt:record.createdAt.toISOString()}:null,choices:COMPANION_CHOICES};
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}

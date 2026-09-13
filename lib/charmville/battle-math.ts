import species from "./species-stats.json";
/** Neutral nature, zero EV subset of pokeemerald CalculateMonStats. */
export function combatStat(id:number,stat:"baseAttack"|"baseDefense"|"baseSpeed",level:number,iv:number){const s=(species.species as Record<string,Record<string,unknown>>)[String(id)];if(!s||typeof s[stat]!=="number")throw Error("Unsupported stats");return Math.floor((2*(s[stat] as number)+iv)*level/100)+5;}
/** Normal physical, neutral typing, no status/abilities/weather. Source:
 * pokemon.c CalculateBaseDamage; battle_script_commands.c damagecalc/random. */
export function normalDamage(level:number,attack:number,defense:number,power:number,critical:boolean,percent:number,stab=false){const base=(Math.floor(Math.floor(attack*power*(Math.floor(2*level/5)+2)/defense)/50)+2)*(critical?2:1);return Math.max(1,Math.floor((stab?Math.floor(base*1.5):base)*percent/100));}

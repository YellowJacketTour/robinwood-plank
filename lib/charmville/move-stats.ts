import catalogue from './move-stats.json';
export type SourceMove = {name:string;power:number;accuracy:number;pp:number;secondaryEffectChance:number;priority:number;effect:string;type:string;target:string;flags:string[]};
/** Source definitions only. An effect being catalogued does not mean it is implemented. */
export function moveStats(id:number):SourceMove|null {
 if(!Number.isInteger(id)||id<1)return null;
 return (catalogue.moves as Record<string,SourceMove>)[String(id)]??null;
}

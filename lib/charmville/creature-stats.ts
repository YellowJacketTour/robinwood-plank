import catalogue from './species-stats.json';
export function speciesStats(speciesId:number){return (catalogue.species as Record<string,{name:string;baseHP:number;types:string[]}>)[String(speciesId)]??null;}
/** pokeemerald src/pokemon.c CalculateMonStats, integer truncation preserved. */
export function maxHp(speciesId:number,level:number,hpIv:number,hpEv:number){
 const species=speciesStats(speciesId);
 if(!species||!Number.isInteger(level)||level<1||level>100||!Number.isInteger(hpIv)||hpIv<0||hpIv>31||!Number.isInteger(hpEv)||hpEv<0||hpEv>255)throw Error('Invalid creature stats');
 if(species.name==='SHEDINJA')return 1;
 return Math.floor((2*species.baseHP+hpIv+Math.floor(hpEv/4))*level/100)+level+10;
}

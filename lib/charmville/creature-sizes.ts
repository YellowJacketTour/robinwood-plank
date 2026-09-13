import catalogue from './species-sizes.json';
export type SpeciesSize={name:string;heightDm:number;weightHg:number};
/** Source Pokédex dimensions, not collision bounds or combat modifiers. */
export function speciesSize(speciesId:number):SpeciesSize|null {
 return (catalogue.species as Record<string,SpeciesSize>)[String(speciesId)]??null;
}
export const speciesSizeProvenance={source:catalogue.source,revision:catalogue.revision,units:catalogue.units};

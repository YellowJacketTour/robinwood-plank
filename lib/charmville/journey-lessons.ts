/** Historical lessons only. Never infer progress from an inventory quantity. */
export function cropLessons(completed:readonly string[]){
 const has=(stage:string)=>completed.includes(`home.crop.${stage}`)||completed.includes(`home.oran.${stage}`);
 return {tilled:completed.includes('home.soil.tilled'),planted:has('planted'),watered:has('watered'),harvested:has('harvested')};
}

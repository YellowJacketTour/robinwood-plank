import { socialItem } from "./social-items";
/** Display names for currently spendable definitions; discovery is not supply. */
export function charmName(id:string){return socialItem(id)?.name ?? id.charAt(0).toUpperCase()+id.slice(1);}

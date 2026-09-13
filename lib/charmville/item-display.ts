import { socialItem } from "./social-items";
/** Presentation metadata only: neither ownership nor permission to spend. */
const burningHeart=Object.freeze({name:'Burning Heart',image:'/charmville/items/burning-heart.svg',description:'A heart blossom warmed by a little flame. Grown to carry a little love.'});
export function charmName(id:string){return id==='burning-heart'?burningHeart.name:socialItem(id)?.name ?? id.charAt(0).toUpperCase()+id.slice(1);}
export function itemArt(id:string){return id==='burning-heart'?burningHeart.image:socialItem(id)?.image;}
export function charmDescription(id:string){return id==='burning-heart'?burningHeart.description:socialItem(id)?.description??'An item held in your account. Available uses depend on the activity you choose.';}

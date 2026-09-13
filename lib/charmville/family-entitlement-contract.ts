// Public identity and draft alpha quantity. Authority remains in the transaction.
export const FAMILY_ENTITLEMENT_VERSION = "burning-heart-family-alpha-01";
export const FAMILY_STARTER_SEEDS = 3;
export type FamilyGiftStatus = {available:false}|{available:true;version:string;accepted:boolean;seedQuantity:number;seeds:string;acceptedAt:string|null};

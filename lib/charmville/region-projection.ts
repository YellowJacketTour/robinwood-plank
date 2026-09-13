import type {SavedActor} from './native-movement-client';

/** Projection ordering only; never authorizes movement or changes saved custody. */
export function acceptsRegionProjection(previous:SavedActor|null,next:SavedActor,profileId:string,regionId:string):boolean {
 if(!next || next.profileId!==profileId || next.regionId!==regionId)return false;
 if(!Number.isSafeInteger(next.regionEpoch)||!Number.isSafeInteger(next.version)||!Number.isSafeInteger(next.sequence))return false;
 if(next.regionEpoch<0||next.version<0||next.sequence<0||!next.cell||!Number.isFinite(next.cell.x)||!Number.isFinite(next.cell.y)||!Number.isFinite(next.tilePixels)||next.tilePixels<=0)return false;
 if(!previous)return true;
 if(next.regionEpoch!==previous.regionEpoch)return next.regionEpoch>previous.regionEpoch;
 return next.version>=previous.version && next.sequence>=previous.sequence;
}

/** Retain scenery during a transient outage, never another admission or live markers. */
export function retainRegionMapDuringReconnect<T extends SavedActor & {peers?:unknown[];stale?:boolean}>(
 previous:{admission:string;state:T}|null,profileId:string,admission:string,
):{admission:string;state:T}|null {
 if(!previous||previous.admission!==admission||previous.state.profileId!==profileId)return null;
 return {...previous,state:{...previous.state,peers:[],stale:true}};
}

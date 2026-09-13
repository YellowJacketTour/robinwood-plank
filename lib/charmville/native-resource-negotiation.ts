import {YardError} from './errors';
import type {NativeResourcePolicy} from './native-resources';
export const NATIVE_CROP_CAPABILITIES='oran-berry,burning-heart';
/** Capability advertisement is not authorization. Both a supported client and
 * explicit local deployment opt-in are required. Production remains v1 until
 * the new native package passes visual and custody acceptance. */
export function nativeResourceRequestPolicy(request:Request,env:Record<string,string|undefined>=process.env):NativeResourcePolicy|undefined {
 const version=request.headers.get('x-charmville-resource-protocol');
 const crops=request.headers.get('x-charmville-resource-crops');
 if(version===null&&crops===null)return;
 if(version!=='2'||crops!==NATIVE_CROP_CAPABILITIES)throw new YardError('Update the game to use these crops',409);
 if(env.NODE_ENV!=='development'||env.CHARMVILLE_NATIVE_CROP_PROTOCOL!=='2')return;
 return {protocolVersion:2,burningHeartEnabled:true};
}

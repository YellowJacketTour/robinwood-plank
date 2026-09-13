import type {WorldEntry} from './world-presence';

/** One logical admission, at most two sends. Never refresh the expected revision
 * between sends: the server must recognize the original operation or reject it.
 * This helper neither invents a destination nor owns authentication/credentials. */
export async function requestWorldEntry<T>(options:{
 entry:WorldEntry;
 request:(entry:Readonly<WorldEntry>)=>Promise<T>;
 signal?:AbortSignal;
 isCurrent?:()=>boolean;
}):Promise<T> {
 const entry=Object.freeze({...options.entry});
 const current=()=>!options.signal?.aborted && (options.isCurrent?.()??true);
 if(!current())throw new DOMException('World entry cancelled','AbortError');
 try{return await options.request(entry);}catch(error){
  const status=(error as {status?:unknown}|null)?.status;
  const transient=typeof status==='number'
   ?[500,502,503,504].includes(status)
   :error instanceof TypeError || error instanceof SyntaxError;
  // No automatic retry for authentication, permissions, stale revisions,
  // throttling, user cancellation, or a newly selected account/destination.
  if(!current() || !transient)throw error;
  return options.request(entry);
 }
}

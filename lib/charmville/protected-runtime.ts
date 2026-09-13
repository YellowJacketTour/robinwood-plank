import type {Pool,PoolClient} from "pg";
import {requireRuntimeSession} from "./runtime-session";
import {openRuntimeArtifact} from "./runtime-artifact";

type ArtifactInput=Omit<Parameters<typeof openRuntimeArtifact>[0],"method"|"signal">;

/** Server-only composition boundary. No manifest lookup, path resolution, stat,
 * hashing or response body is opened until current session/admission succeeds.
 * HEAD is subject to exactly the same authorization as GET. Immutable release
 * configuration belongs to the caller, never query parameters or client bodies.
 */
export async function openProtectedRuntimeArtifact(
  db:Pool|PoolClient,request:Request,input:ArtifactInput,
  env:Parameters<typeof requireRuntimeSession>[2]=process.env,
) {
  await requireRuntimeSession(db,request,env);
  return openRuntimeArtifact({...input,method:request.method,signal:request.signal});
}

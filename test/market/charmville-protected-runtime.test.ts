import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import type {Pool} from "pg";
import {openProtectedRuntimeArtifact} from "../../lib/charmville/protected-runtime";
import {RUNTIME_SESSION_COOKIE} from "../../lib/charmville/runtime-session";
import {YardError} from "../../lib/charmville/errors";

const env={NODE_ENV:"production",CHARMVILLE_ACCESS_MODE:"private"};
const wallet="0x"+"b".repeat(40);
function request(method:string,cookie=true) {
  return new Request("https://example.test/charmville/runtime/release/play/main.js",{
    method,headers:cookie?{cookie:`${RUNTIME_SESSION_COOKIE}=${"c".repeat(64)}`}:{},
  });
}
function database(admitted:boolean,ticket=true) {
  const statements:string[]=[];
  return {statements,db:{query:async(sql:string)=>{
    statements.push(sql);
    if(sql.includes("charmville_runtime_sessions"))return {rows:ticket?[{id:"42"}]:[]};
    if(sql.includes("plankspace_profiles"))return {rows:[{wallet}]};
    if(sql.includes("charmville_admission_grants"))return {rows:admitted?[{}]:[],rowCount:admitted?1:0};
    throw Error("Unexpected authority query");
  }} as unknown as Pool};
}
function watchedArtifact() {
  let reads=0;
  // Reading these configuration properties is required before the artifact
  // helper can identify any filesystem path. Denied requests must not touch them.
  return {get reads(){return reads;},input:{
    get manifest(){reads++;throw Error("Unauthorized artifact lookup");},
    get roots(){reads++;throw Error("Unauthorized filesystem root access");},
    configuredRelease:"release",requestedRelease:"release",route:"/play/main.js",
  }};
}

test("GET and HEAD denied sessions never resolve artifact configuration or open files",async()=>{
  for(const method of ["GET","HEAD"]) {
    for(const cookie of [false,true]) {
      const f=watchedArtifact(),{db}=database(true,false);
      await assert.rejects(openProtectedRuntimeArtifact(db,request(method,cookie),f.input,env),
        error=>error instanceof YardError&&error.status===401);
      assert.equal(f.reads,0);
    }
  }
});

test("a live ticket cannot bypass current grant revocation even for HEAD",async()=>{
  for(const method of ["GET","HEAD"]) {
    const f=watchedArtifact(),{db,statements}=database(false);
    await assert.rejects(openProtectedRuntimeArtifact(db,request(method),f.input,env),
      error=>error instanceof YardError&&error.status===403);
    assert.ok(statements.some(sql=>sql.includes("charmville_admission_grants")));
    assert.equal(f.reads,0);
  }
});

test("authorized GET streams verified bytes; HEAD rechecks authority and returns no body",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"charm-runtime-auth-"));
  try {
    const bytes=Buffer.from("export const privateRuntime = true;\n");
    await writeFile(path.join(root,"main.js"),bytes);
    const input={configuredRelease:"release",requestedRelease:"release",route:"/play/main.js",
      roots:{repo:root,runtime:root,content:root,sprite:root},
      manifest:{schemaVersion:1,scope:"joined-homestead-private-inventory",completeInventory:true,issues:[],files:[{
        status:"present",role:"served",root:"runtime",path:"main.js",route:"/play/main.js",bytes:bytes.length,
        sha256:createHash("sha256").update(bytes).digest("hex"),
      }]}};
    const {db,statements}=database(true);
    const get=await openProtectedRuntimeArtifact(db,request("GET"),input,env);
    assert.ok(get.body);const chunks:Buffer[]=[];
    for await(const chunk of get.body)chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks),bytes);
    const head=await openProtectedRuntimeArtifact(db,request("HEAD"),input,env);
    assert.equal(head.body,null);assert.equal(head.headers["Content-Length"],String(bytes.length));
    assert.equal(statements.filter(sql=>sql.includes("charmville_runtime_sessions")).length,2);
    assert.equal(statements.filter(sql=>sql.includes("charmville_admission_grants")).length,2);
    assert.equal(head.headers["Cache-Control"],"private, no-store");
  } finally {
    const relative=path.relative(path.resolve(tmpdir()),path.resolve(root));
    assert.ok(relative.startsWith("charm-runtime-auth-")&&!relative.includes(path.sep)&&!path.isAbsolute(relative));
    await rm(root,{recursive:true,force:true});
  }
});

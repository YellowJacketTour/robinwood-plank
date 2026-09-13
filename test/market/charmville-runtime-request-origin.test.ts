import test from 'node:test';
import assert from 'node:assert/strict';
import {requireRuntimeRequestOrigin} from '../../lib/charmville/runtime-request-origin';
const env={NODE_ENV:'production'};
test('public HTTPS origin survives Passenger internal HTTP URLs without trusting forwarded headers',()=>{
 const url='http://127.0.0.1:3000/charmville/runtime/session';
 assert.doesNotThrow(()=>requireRuntimeRequestOrigin(new Request(url,{headers:{Origin:'https://plank.love','Sec-Fetch-Site':'same-origin'}}),{env}));
 for(const origin of ['https://evil.example','http://plank.love','https://plank.love.evil.example','null','']) assert.throws(()=>requireRuntimeRequestOrigin(new Request(url,{headers:{Origin:origin,'X-Forwarded-Host':'plank.love','X-Forwarded-Proto':'https'}}),{env}));
 assert.throws(()=>requireRuntimeRequestOrigin(new Request(url,{headers:{Origin:'https://plank.love','Sec-Fetch-Site':'cross-site'}}),{env}));
});
test('renewal requires origin while bearer issuance permits absent origin; development is loopback only',()=>{
 const req=new Request('http://localhost:3018/api/charmville/runtime-session');
 assert.throws(()=>requireRuntimeRequestOrigin(req,{env}));
 assert.doesNotThrow(()=>requireRuntimeRequestOrigin(req,{env,allowMissing:true}));
 const dev={NODE_ENV:'development'};
 assert.doesNotThrow(()=>requireRuntimeRequestOrigin(new Request(req.url,{headers:{Origin:'http://localhost:3018'}}),{env:dev}));
 assert.throws(()=>requireRuntimeRequestOrigin(new Request(req.url,{headers:{Origin:'http://localhost:3017'}}),{env:dev}));
 assert.throws(()=>requireRuntimeRequestOrigin(new Request('https://evil.example',{headers:{Origin:'https://evil.example'}}),{env:dev}));
});

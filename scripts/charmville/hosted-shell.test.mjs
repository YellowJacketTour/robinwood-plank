import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('./runtime-shell.mjs',import.meta.url),'utf8');
const body=source.slice(source.indexOf('export function compactHostedShell'),source.indexOf('export function mountRuntimeShell')).replace('export ','');
const compactHostedShell=runInNewContext(body+'; compactHostedShell',{Event});
test('accepted host compacts menu once without repeated resize or removing controls',()=>{
 const classes=new Set();let resizes=0;
 const menu={textContent:'Game menus'},summary={textContent:'Settings & help'};
 const root={body:{classList:{contains:key=>classes.has(key),add:key=>classes.add(key)}},querySelector:selector=>selector==='.charm-account-menu'?menu:summary,defaultView:{dispatchEvent:event=>{assert.equal(event.type,'resize');resizes++;}}};
 assert.equal(compactHostedShell(root),true);assert.equal(menu.textContent,'Game menu');assert.equal(summary.textContent,'Controls & settings');
 assert.equal(compactHostedShell(root),false);assert.equal(resizes,1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
// @ts-expect-error standalone deployment module
import { notificationDeferralCandidate, canDeferNotificationLock } from '../../scripts/notification-migration-policy.mjs';
import { Client } from 'pg';
import { MarketChangeFeed } from '../../lib/market/multichain/edge/change-feed';
import { hasPostgresConfig, closePostgres } from '../../lib/postgres';
import type { MarketChange } from '../../lib/market/multichain/edge/change-protocol';

test('only the exact reviewed optional migration can defer; required migrations and non-lock failures stay fatal', async()=>{
 const sql=await readFile('deploy/inmotion/postgres/migrations/110_market_change_notifications.sql','utf8');
 assert.equal(notificationDeferralCandidate(true,'110_market_change_notifications.sql',sql),true);
 assert.equal(notificationDeferralCandidate(false,'110_market_change_notifications.sql',sql),false);
 assert.equal(notificationDeferralCandidate(true,'111_discovery.sql',sql),false);
 assert.equal(notificationDeferralCandidate(true,'110_market_change_notifications.sql',sql+'\nSELECT 1;'),false);
 let reads=0;
 const client={query:async()=>{reads++;return {rows:[{blocked:true}]};}};
 assert.equal(await canDeferNotificationLock(client,true,{code:'42P01'}),false);
 assert.equal(await canDeferNotificationLock(client,false,{code:'55P03'}),false);
 assert.equal(reads,0);
 assert.equal(await canDeferNotificationLock(client,true,{code:'55P03'}),true);
 assert.equal(await canDeferNotificationLock({query:async()=>({rows:[{blocked:false}]})},true,{code:'55P03'}),false);
});

test('pending notification installation emits periodic resync and transitions to notifications without disconnecting', {skip:!hasPostgresConfig()},async()=>{
 class PendingFeed extends MarketChangeFeed {
   available=false;
   protected override async notificationSchemaReady(_client:Client) {return this.available;}
 }
 const feed=new PendingFeed(40);
 const received:MarketChange[]=[];
 const off=feed.subscribe([{chainSlug:'eth-mainnet',collectionKey:'test'}],change=>received.push(change));
 const waitFor=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert.ok(check());};
 try {
   await waitFor(()=>received.filter(c=>c.reason==='notifications-pending-periodic-resync').length>=2);
   assert.equal(feed.stats.deliveryMode,'periodic-resync');
   feed.available=true;
   await waitFor(()=>received.some(c=>c.reason==='notifications-activated'));
   assert.equal(feed.stats.deliveryMode,'notifications');
   const polls=received.filter(c=>c.reason==='notifications-pending-periodic-resync').length;
   await new Promise(r=>setTimeout(r,120));
   assert.equal(received.filter(c=>c.reason==='notifications-pending-periodic-resync').length,polls);
 } finally {off();feed.stop();await closePostgres();}
});

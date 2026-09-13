import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nearbyVisitTargets,travelLabel,visitHandle} from '../../lib/charmville/friend-travel';
test('friend destinations normalize handles without accepting paths or arbitrary addresses',()=>{
 assert.equal(visitHandle(' @Meadow_Friend '),'meadow_friend');
 for(const value of ['', '@@friend','../friend','https://example.com','x'.repeat(41)])assert.equal(visitHandle(value),null);
});
test('travel labels follow admitted presence and nearby people never imply home access',()=>{
 const state={active:true,ownerHandle:'friend',peers:[{profileId:'1',handle:'me'},{profileId:'2',handle:'friend'},{profileId:'3',handle:'friend'},{profileId:'4',handle:'../bad'}]};
 assert.equal(travelLabel(state,'me'),'Visiting @friend’s homestead');
 assert.equal(travelLabel({...state,ownerHandle:'me'},'me'),'At your homestead');
 assert.equal(travelLabel({...state,active:false},'me'),'Choose where to join');
 assert.deepEqual(nearbyVisitTargets(state,'1'),[{profileId:'2',handle:'friend'}]);
 assert.deepEqual(nearbyVisitTargets({...state,active:false},'1'),[]);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localHeartSocialPolicy} from '../../lib/charmville/social-policy';
test('Heart social requires local development, explicit server opt-in and negotiated protocol',()=>{
 const env={NODE_ENV:'development',CHARMVILLE_LOCAL_HEART_SOCIAL:'1'};
 const request=(url='http://localhost:3018/api/charmville/social',protocol='social-items-v2')=>new Request(url,{headers:{'x-charmville-social-protocol':protocol}});
 assert.deepEqual(localHeartSocialPolicy(request(),env),{burningHeart:true,clientProtocol:'social-items-v2'});
 for(const candidate of [{...env,NODE_ENV:'production'},{...env,CHARMVILLE_LOCAL_HEART_SOCIAL:'0'},{}])assert.equal(localHeartSocialPolicy(request(),candidate),undefined);
 for(const url of ['https://plank.love/api/charmville/social','http://localhost.example/api/charmville/social','http://192.168.1.1/api/charmville/social'])assert.equal(localHeartSocialPolicy(request(url),env),undefined);
 assert.equal(localHeartSocialPolicy(request(undefined,'legacy'),env),undefined);
});

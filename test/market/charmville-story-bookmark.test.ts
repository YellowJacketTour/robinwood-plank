import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseStoryBookmark,storyBookmarkKey} from '../../lib/charmville/story-bookmark';

test('reading positions use a bounded profile namespace and never accept a wallet session or arbitrary storage key',()=>{
 assert.notEqual(storyBookmarkKey('26'),storyBookmarkKey('27'));
 for(const bad of ['', '../26', '26:session', 'x'.repeat(97), 'a'.repeat(64), '0x'+'1'.repeat(40)])assert.equal(storyBookmarkKey(bad),null);
});
test('reading preferences validate version, fields and page range instead of granting completion from browser data',()=>{
 assert.deepEqual(parseStoryBookmark('{"version":1,"page":3,"finished":false}'),{version:1,page:3,finished:false});
 assert.deepEqual(parseStoryBookmark('{"version":1,"page":0,"finished":true}'),{version:1,page:0,finished:true});
 for(const raw of [null,'garbage','[]','null','{}','{"version":2,"page":0,"finished":false}','{"version":1,"page":-1,"finished":false}','{"version":1,"page":6,"finished":false}','{"version":1,"page":1.5,"finished":false}','{"version":1,"page":0,"finished":"yes"}','{"version":1,"page":0,"finished":false,"grant":"fairy"}'])assert.equal(parseStoryBookmark(raw),null);
});

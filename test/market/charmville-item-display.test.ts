import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {charmName,itemArt,charmDescription} from '../../lib/charmville/item-display';
import {requireNativeCrop} from '../../lib/charmville/native-crops';
import {socialItem} from '../../lib/charmville/social-items';

test('Burning Heart display identity does not alias Oran or activate issuance/social spending',()=>{
 assert.equal(charmName('burning-heart'),'Burning Heart');
 assert.equal(itemArt('burning-heart'),'/charmville/items/burning-heart.svg');
 assert.equal(charmName('oran-berry'),'Oran Berry');
 assert.notEqual(itemArt('burning-heart'),itemArt('oran-berry'));
 assert.match(charmDescription('burning-heart'),/heart blossom/);
 assert.equal(socialItem('burning-heart'),undefined);
 assert.throws(()=>requireNativeCrop('burning-heart'),/unavailable/);
 assert.equal(itemArt('unknown-item'),undefined);
});

test('original heart artwork is a self-contained static vector with no network or executable content',async()=>{
 const svg=await readFile(new URL('../../public/charmville/items/burning-heart.svg',import.meta.url),'utf8');
 assert.match(svg,/viewBox="0 0 32 32"/);
 assert.match(svg,/<title>Burning Heart<\/title>/);
 assert.doesNotMatch(svg,/<(?:script|foreignObject|image|use|animate|set)\b|\son\w+=|href=|url\(/i);
 assert.match(svg,/fill="#F43F5E"/);
 assert.match(svg,/fill="#E9B43F"/);
 assert.match(svg,/fill="#24693F"/);
});

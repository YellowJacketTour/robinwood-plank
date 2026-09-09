import {test} from 'node:test';import assert from 'node:assert/strict';
import {createNativeContactObserver,readNativeContact} from '../../lib/charmville/native-contact-observer';
const sessionId='11111111-1111-4111-8111-111111111111';
const contact={type:'charmville:action-contact',sessionId,eventId:sessionId+':1',sequence:1,action:'water',plotIndex:0,dmap:4,screen:63,x:24,y:72,direction:1,authority:'local-observation'};
test('native contact rejects reward claims and malformed coordinates',()=>{assert(readNativeContact(contact));for(const patch of [{reward:10},{authority:'server'},{plotIndex:3},{sequence:0},{x:NaN},{direction:4},{eventId:'wrong'}])assert.equal(readNativeContact({...contact,...patch}),null);});
test('native observations deduplicate and expose gaps without claiming settlement',()=>{const observe=createNativeContactObserver();assert.equal(observe(contact)?.gap,false);assert.equal(observe(contact),null);assert.equal(observe({...contact,eventId:sessionId+':3',sequence:3})?.gap,true);assert.equal(observe({...contact,eventId:sessionId+':2',sequence:2}),null);});

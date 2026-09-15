import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('./display-controls.js',import.meta.url),'utf8');
const fitSource=source.slice(source.indexOf('function fit(){'),source.indexOf('function setZoom'));
function measure({host=true,loading=false,headerHeight=52,width=1000,height=800,zoom=1,mobile=false}={}){
 const values={};const canvas={width:768,height:690,style:{setProperty:(key,value)=>values[key]=parseFloat(value)}};
 const context={canvas,innerWidth:width,innerHeight:height,zoom,matchMedia:()=>({matches:mobile}),header:{querySelector:()=>loading?{}:null,getBoundingClientRect:()=>({height:headerHeight})},document:{fullscreenElement:null,body:{classList:{contains:()=>host}}},pixels:{checked:false},slider:{},output:{}};
 runInNewContext(fitSource+';fit()',context);return {width:values['--charm-width'],height:values['--charm-height'],backbuffer:[canvas.width,canvas.height]};
}
test('hosted canvas reclaims the native rail and stays stable while settings overlay opens',()=>{
 const play=measure(),settings=measure({headerHeight:380});assert.deepEqual(play,settings);
 assert.equal(play.height,800);assert.deepEqual(play.backbuffer,[768,690]);
 assert.ok(Math.abs(play.width/play.height-768/690)<.002);
});
test('start/retry remains in layout and older hosts retain their reachable rail',()=>{
 const loading=measure({loading:true}),legacy=measure({host:false});
 assert.deepEqual(loading,legacy);assert.equal(loading.height,728);
});
test('immersive display zoom cannot crop the frame and touch controls retain space',()=>{
 const fit=measure(),large=measure({zoom:2});assert.deepEqual(large,fit);
 for(const [width,height] of [[320,640],[640,320],[1920,1080]]){
  const view=measure({width,height,mobile:width<1000});assert.ok(view.width<=width&&view.height<=height);
  assert.ok(view.width>0&&view.height>0);assert.deepEqual(view.backbuffer,[768,690]);
 }
});

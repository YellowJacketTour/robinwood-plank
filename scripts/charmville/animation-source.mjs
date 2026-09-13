import {PNG} from 'pngjs';

// Restricted XML reader for the attribute-free SpriteCollab AnimData schema.
// No DTD, entities, network resolution, recovery, or partial malformed parses.
export function parseAnimationXml(xml){
 const text=xml.replace(/^\s*<\?xml[^?]*\?>/,'').replace(/<!--[\s\S]*?-->/g,'');
 if(/[&]|<!|<\?/.test(text))throw Error('Unsupported XML declaration/entity');
 const root={name:'document',children:[],text:''},stack=[root];
 const parts=text.match(/<[^>]*>|[^<]+/g)||[];
 if(parts.join('')!==text)throw Error('Malformed XML');
 for(const part of parts){
  if(part.startsWith('<')){
   const tag=part.match(/^<(\/?)([A-Za-z][A-Za-z0-9]*)\s*>$/);if(!tag)throw Error('Invalid XML tag');
   if(tag[1]){if(stack.length===1||stack.pop().name!==tag[2])throw Error('Unbalanced XML');}
   else{const node={name:tag[2],children:[],text:''};stack.at(-1).children.push(node);stack.push(node);}
  }else stack.at(-1).text+=part;
 }
 if(stack.length!==1||root.children.length!==1||root.children[0].name!=='AnimData'||root.text.trim())throw Error('Invalid AnimData root');
 const one=(node,name,required=false)=>{const matches=node.children.filter(child=>child.name===name);if(matches.length>1||(required&&!matches.length))throw Error(`Expected one ${name}`);return matches[0];};
 const leaf=(node,name,required=false)=>{const child=one(node,name,required);if(!child)return null;if(child.children.length)throw Error(`Invalid ${name}`);return child.text.trim();};
 const integer=(value,label,min=0,max=65535)=>{if(!/^\d+$/.test(value??'')||Number(value)<min||Number(value)>max)throw Error(`Invalid ${label}`);return Number(value);};
 const data=root.children[0],anims=one(data,'Anims',true),shadowSize=integer(leaf(data,'ShadowSize',true),'ShadowSize',0,2),names=new Map(),indexes=new Set();
 for(const node of anims.children){
  if(node.name!=='Anim')throw Error('Unknown animation node');
  const name=leaf(node,'Name',true);if(!/^[A-Za-z][A-Za-z0-9]*$/.test(name)||names.has(name))throw Error('Invalid or duplicate animation name');
  const indexText=leaf(node,'Index'),index=indexText===null?null:integer(indexText,'Index');if(index!==null){if(indexes.has(index))throw Error('Duplicate Index');indexes.add(index);}
  const copyOf=leaf(node,'CopyOf');
  if(copyOf!==null){if(node.children.some(child=>!['Name','Index','CopyOf'].includes(child.name)))throw Error('CopyOf has physical metadata');names.set(name,{name,index,copyOf});continue;}
  const width=integer(leaf(node,'FrameWidth',true),'FrameWidth',2,1024),height=integer(leaf(node,'FrameHeight',true),'FrameHeight',2,1024);if(width%2||height%2)throw Error('Frame dimensions must be even');
  const durationNode=one(node,'Durations',true);if(!durationNode.children.length||durationNode.children.length>1024)throw Error('Invalid duration count');
  const durations=durationNode.children.map(child=>{if(child.name!=='Duration'||child.children.length)throw Error('Invalid Duration');return integer(child.text.trim(),'Duration',1,10000);});
  const specified={};for(const [key,tag] of [['rush','RushFrame'],['hit','HitFrame'],['return','ReturnFrame']]){const value=leaf(node,tag);specified[key]=value===null?null:integer(value,tag,0,durations.length-1);}
  const effective={rush:specified.rush??0,return:specified.return??durations.length-1};effective.hit=specified.hit??effective.return;
  if(effective.rush>effective.hit||effective.hit>effective.return)throw Error('Invalid marker order');
  names.set(name,{name,index,copyOf:null,width,height,durations,markers:{specified,effective},durationTicks:durations.reduce((sum,n)=>sum+n,0)});
 }
 const resolve=(name,trail=[])=>{if(trail.includes(name))throw Error('CopyOf cycle');const node=names.get(name);if(!node)throw Error(`Missing CopyOf ${name}`);if(!node.copyOf)return {...node,sourceAnimation:name};const target=resolve(node.copyOf,[...trail,name]);if(names.get(node.copyOf).copyOf)throw Error('CopyOf chains unsupported by source format');return {...target,name:node.name,index:node.index,copyOf:node.copyOf};};
 return {shadowSize,ticksPerSecond:60,animations:[...names.keys()].map(name=>resolve(name))};
}

export function readAnimationSheets(animation,sheets){
 const images=Object.fromEntries(Object.entries(sheets).map(([key,bytes])=>[key,PNG.sync.read(bytes)]));
 const {anim,offsets,shadow}=images;
 if(!anim||!offsets||!shadow||[offsets,shadow].some(p=>p.width!==anim.width||p.height!==anim.height))throw Error('Sheet dimensions disagree');
 if(anim.width!==animation.width*animation.durations.length||anim.height%animation.height)throw Error('Sheet/frame dimensions disagree');
 const directions=anim.height/animation.height;if(![1,8].includes(directions))throw Error('Invalid direction rows');
 const frames=[];
 for(let row=0;row<directions;row++)for(let frame=0;frame<animation.durations.length;frame++){
  const points={body:[],red:[],blue:[],head:[],shadow:[]};
  for(let y=0;y<animation.height;y++)for(let x=0;x<animation.width;x++){
   const i=((row*animation.height+y)*anim.width+frame*animation.width+x)*4;
   const [r,g,b,a]=offsets.data.subarray(i,i+4);
   if(a){if(g===255)points.body.push({x,y});if(r===255)points.red.push({x,y});if(b===255)points.blue.push({x,y});if(r===0&&g===0&&b===0)points.head.push({x,y});}
   const [sr,sg,sb,sa]=shadow.data.subarray(i,i+4);if(sa&&sr===255&&sg===255&&sb===255)points.shadow.push({x,y});
  }
  for(const [key,value] of Object.entries(points))if(value.length>1)throw Error(`Ambiguous ${key} anchor in row ${row}, frame ${frame}`);
  frames.push({row,frame,body:points.body[0]??null,red:points.red[0]??null,blue:points.blue[0]??null,head:points.head[0]??points.body[0]??null,headFallback:!points.head.length,shadow:points.shadow[0]??null});
 }
 return {sheetWidth:anim.width,sheetHeight:anim.height,directionRows:directions,frames};
}

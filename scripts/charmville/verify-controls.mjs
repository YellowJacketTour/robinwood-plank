import assert from 'node:assert/strict';

/** Exercises browser inputs against the rendered actor, without injecting actor state. */
export async function verifyControls(page) {
  const actor = page.locator('[data-groundskeeper]');
  const controls = page.getByRole('group', {name:'Garden controls: click to walk, WASD or arrows to move, E to interact'});
  const pose = () => actor.evaluate(el => ({x:Number(el.dataset.x),y:Number(el.dataset.y),direction:Number(el.dataset.direction),moving:el.dataset.moving==='true'}));
  const stable = async () => {
    await page.waitForFunction(()=>document.querySelector('[data-groundskeeper]')?.dataset.moving==='false');
    const before=await pose(); await page.waitForTimeout(180); const after=await pose();
    assert.ok(Math.hypot(after.x-before.x,after.y-before.y)<.025,'Actor should stop after input release');
  };
  await controls.scrollIntoViewIfNeeded();
  // Click an open point beyond the fence. The browser transforms the live SVG point.
  const point=await page.getByLabel('Isometric Charmville yard').evaluate(svg=>{
    const p=new DOMPoint(360+(9-7)*40,70+(9+7)*20).matrixTransform(svg.getScreenCTM());
    return {x:p.x,y:p.y};
  });
  await page.mouse.click(point.x,point.y);
  await page.waitForFunction(()=>{const el=document.querySelector('[data-groundskeeper]');return Math.abs(Number(el?.dataset.x)-9)<.03&&Math.abs(Number(el?.dataset.y)-7)<.03;});
  await stable();
  assert.equal(await controls.evaluate(el=>el===document.activeElement),true,'Click movement should focus game controls');
  const beforeKey=await pose();
  await page.keyboard.down('ArrowUp');await page.waitForTimeout(240);const up=await pose();await page.keyboard.up('ArrowUp');
  assert.ok(up.x<beforeKey.x-.12&&up.y<beforeKey.y-.12,'ArrowUp should move visually upward');
  assert.equal(up.direction,4,'Upward movement must show the back-facing atlas');
  await stable();
  await page.keyboard.down('s');await page.waitForTimeout(220);const down=await pose();await page.keyboard.up('s');
  assert.ok(down.x>up.x+.1&&down.y>up.y+.1,'S should move visually downward');
  assert.equal(down.direction,0,'Downward movement must face the camera');
  await stable();
  // Keyboard must not move the actor once focus leaves the game.
  await page.getByRole('button',{name:'Satchel',exact:true}).focus();
  const unfocused=await pose();await page.keyboard.down('ArrowUp');await page.waitForTimeout(180);await page.keyboard.up('ArrowUp');
  const noMove=await pose();assert.ok(Math.hypot(noMove.x-unfocused.x,noMove.y-unfocused.y)<.025,'Keyboard movement escaped the game focus boundary');
  await page.setViewportSize({width:390,height:844});
  const left=page.getByRole('button',{name:'Walk left',exact:true});await left.scrollIntoViewIfNeeded();
  const touchBox=await left.boundingBox();assert.ok(touchBox&&touchBox.width>=44&&touchBox.height>=44,'Touch controls need a 44px target');
  const cdp=await page.context().newCDPSession(page);
  const beforeTouch=await pose();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:touchBox.x+touchBox.width/2,y:touchBox.y+touchBox.height/2}]});
  await page.waitForTimeout(240);const movedTouch=await pose();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.ok(movedTouch.x<beforeTouch.x-.1&&movedTouch.y>beforeTouch.y+.1,'Held touch-left must move the actor left');
  assert.equal(movedTouch.direction,2,'Touch-left must show the left-facing atlas');await stable();
  await cdp.detach();
  await controls.focus();
  await page.evaluate(()=>{
    window.__charmTestPad={id:'Regression standard controller',index:0,connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},()=>({pressed:false,touched:false,value:0})),timestamp:performance.now()};
    Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[window.__charmTestPad,null,null,null]});
    window.dispatchEvent(new Event('gamepadconnected'));
  });
  const beforePad=await pose();await page.evaluate(()=>window.__charmTestPad.axes[0]=1);
  await page.waitForTimeout(220);const movedPad=await pose();await page.evaluate(()=>window.__charmTestPad.axes[0]=0);
  assert.ok(movedPad.x>beforePad.x+.1&&movedPad.y<beforePad.y-.1,'Standard gamepad left stick must move right');
  assert.equal(movedPad.direction,6,'Gamepad-right must show the right-facing atlas');await stable();
  const beforeDpad=await pose();await page.evaluate(()=>window.__charmTestPad.buttons[12]={pressed:true,touched:true,value:1});
  await page.waitForTimeout(200);const movedDpad=await pose();await page.evaluate(()=>window.__charmTestPad.buttons[12]={pressed:false,touched:false,value:0});
  assert.ok(movedDpad.x<beforeDpad.x-.1&&movedDpad.y<beforeDpad.y-.1,'Standard gamepad D-pad must move upward');await stable();
  await page.evaluate(()=>{delete navigator.getGamepads;delete window.__charmTestPad;});
  await page.setViewportSize({width:1280,height:1100});
  console.log('Controls: click path arrival, keyboard movement/facing/focus, held touch/release, standard gamepad stick/D-pad/release passed.');
}

export async function verifyGamepadAction(page) {
  let resolves=0;
  const onRequest=request=>{
    if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/charmville/')) {
      try {if(request.postDataJSON()?.action==='resolve')resolves++;} catch { /* non-action request */ }
    }
  };
  page.on('request',onRequest);
  try {
    await page.getByRole('button',{name:'Choose plot 2',exact:true}).click();
    await page.getByRole('group',{name:'Garden controls: click to walk, WASD or arrows to move, E to interact'}).focus();
    await page.evaluate(()=>{
      const pad={id:'Regression standard controller',index:0,connected:true,mapping:'standard',axes:[0,0,0,0],buttons:Array.from({length:17},(_,index)=>({pressed:index===0,touched:index===0,value:index===0?1:0})),timestamp:performance.now()};
      Object.defineProperty(navigator,'getGamepads',{configurable:true,value:()=>[pad,null,null,null]});
    });
    const bag=page.getByRole('dialog',{name:'Satchel'});await bag.waitFor();
    await page.waitForTimeout(200);
    assert.equal(resolves,1,'Held controller A should issue one harvest after walking to the selected ripe bed');
    await page.evaluate(()=>{delete navigator.getGamepads;});
    await bag.getByRole('button',{name:'Close satchel',exact:true}).click();
    console.log('Controller A: walks to the selected ripe bed, harvests once, and opens the satchel.');
  } finally {page.off('request',onRequest);await page.evaluate(()=>{delete navigator.getGamepads;});}
}

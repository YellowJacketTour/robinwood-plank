import {CRASH_FINALE_MS,REDUCED_CRASH_FINALE_MS,lotteryDelay} from './presentation-timing.js';

import {playerLotteryOdds} from './lottery-player-odds.js';

import {MAX_PHYSICAL_BALLS} from './lottery-population.js';

import {mountLotteryMachine} from './lottery-machine-3d.js';

const dialog=document.createElement('dialog');dialog.className='lottery-theatre';

dialog.setAttribute('aria-labelledby','lotteryTitle');

dialog.innerHTML='<div class="lottery-theatre-head"><span>Lottery</span><button class="lottery-close" aria-label="Close lottery">✕</button></div><div class="lottery-theatre-scene"></div><h2 id="lotteryTitle" aria-live="polite"></h2><p class="lottery-odds"></p><div class="lottery-prize-summary"><canvas class="lottery-prize-art" role="button" tabindex="0" aria-label="Tumble prize sculpture" hidden></canvas><div><small class="lottery-amount-label"></small><div class="lottery-amount"></div></div></div><details class="lottery-details"><summary>Your odds</summary><p class="lottery-personal-odds"></p></details><small class="lottery-status" aria-live="polite"></small><div class="lottery-actions"><button class="lottery-collect" hidden>Collect prize</button><button class="lottery-next">Back to flight</button></div>';

document.body.append(dialog);

let dispose=null,lastResult=null,returnTimer=null,presentation=0,revealTimer=null,assetTimer=null;
let prizeScene=null,prizeInit=null,prizeKey='';
function preparePrize(result){
  if(!prizeInit)prizeInit=import('./prize-showcase.js').then(({createPrizeShowcase})=>prizeScene=createPrizeShowcase(dialog.querySelector('.lottery-prize-art'))).catch(()=>null);
  if(!result||result.verified!==true)return;
  const value=result.hit?result.paid:result.nextPrize,key=String(result.roundId)+':'+value;
  void prizeInit.then(scene=>{if(!scene||result!==lastResult||prizeKey===key)return;prizeKey=key;scene.prepare(value);dialog.querySelector('.lottery-prize-art').setAttribute('aria-label',`Tumble prize sculpture · ${value} ETH${result.testFunds?' · simulated':''}`);if(dialog.open&&dialog.dataset.reveal==='presented')scene.show();});
}
document.addEventListener('plank:lottery-prepare',()=>preparePrize(null));


// Prepare recorded draw artwork off-screen while its flight replay runs.
let preparedScene=null;
const staging=document.createElement('div');
staging.style.cssText='position:fixed;left:-10000px;top:0;width:480px;height:480px;visibility:hidden;pointer-events:none';
document.body.append(staging);
function prepareScene(result){
  if(!result?.ballCount||BigInt(result.ballCount)<=0n)return;
  if(preparedScene?.roundId===String(result.roundId))return;
  preparedScene?.dispose?.();staging.replaceChildren();
  const canvas=document.createElement('canvas');canvas.style.cssText='width:100%;height:100%';staging.append(canvas);
  const item={roundId:String(result.roundId),ballCount:String(result.ballCount),drawnBall:String(result.drawnBall),canvas,dispose:null,failed:false,reveal:null,ready:false,open:null};preparedScene=item;
  canvas.addEventListener('lottery-render-error',()=>{item.failed=true;});
  try{item.dispose=mountLotteryMachine(canvas,{result:{...result,drawLabel:String(result.drawnBall)},paused:true,onPrepared:()=>{item.ready=true;item.open?.();},onReady:()=>item.reveal?.()});}catch{item.failed=true;}
}
document.addEventListener('plank:lottery-prepare',event=>prepareScene(event.detail));

const money=value=>`Ξ ${Number(value||0).toLocaleString('en-US',{maximumSignificantDigits:5})}`;

const stopReturn=()=>{clearTimeout(returnTimer);returnTimer=null;};

const stopAssets=()=>{clearTimeout(assetTimer);assetTimer=null;};

const closed=()=>document.dispatchEvent(new CustomEvent('plank:lottery-closed',{detail:{roundId:dialog.dataset.roundId||null}}));

const close=()=>{presentation++;stopReturn();stopAssets();dialog.close();prizeScene?.hide();dispose?.();dispose=null;closed();};

dialog.querySelector('.lottery-close').addEventListener('click',close);

dialog.querySelector('.lottery-next').addEventListener('click',close);

dialog.addEventListener('cancel',()=>{presentation++;stopReturn();stopAssets();prizeScene?.hide();dispose?.();dispose=null;closed();});

dialog.addEventListener('pointerdown',stopReturn);

dialog.addEventListener('keydown',stopReturn);

function previewResult(result){return !result||!result.myStake||BigInt(result.myStake)===0n;}

function show(result,scheduled=false){

  dialog.dataset.roundId=result?.roundId||'';

  clearTimeout(revealTimer);revealTimer=null;

  const generation=++presentation;

  stopReturn();stopAssets();prizeScene?.hide();dispose?.();dispose=null;dialog.dataset.reveal='drawing';delete dialog.dataset.collected;

  const cached=preparedScene?.roundId===String(result?.roundId)&&preparedScene.ballCount===String(result?.ballCount)&&preparedScene.drawnBall===String(result?.drawnBall)&&!preparedScene.failed?preparedScene:null;
  if(cached)preparedScene=null;
  const host=dialog.querySelector('.lottery-theatre-scene'),canvas=cached?.canvas||document.createElement('canvas');canvas.setAttribute('aria-hidden','true');host.replaceChildren(canvas);

  const title=dialog.querySelector('h2'),copy=dialog.querySelector('.lottery-odds'),amount=dialog.querySelector('.lottery-amount'),status=dialog.querySelector('.lottery-status'),collect=dialog.querySelector('.lottery-collect');

  title.textContent=result?'Drawing…':'Prize machine';amount.textContent='';dialog.querySelector('.lottery-amount-label').textContent='';dialog.querySelector('.lottery-details').hidden=previewResult(result);dialog.querySelector('.lottery-details').open=false;collect.hidden=true;collect.disabled=false;

  status.textContent=result?`Round ${result.roundId} · verified result`:'Preview · no wager or payout';

  const open=()=>{if(generation===presentation&&!dialog.open){dialog.showModal();document.dispatchEvent(new CustomEvent("plank:lottery-opening",{detail:{roundId:result?.roundId||null}}));}};

  const preview=!result,numbered=preview||result.ballCount!==undefined;

  const shown=preview?{hit:true,ballCount:'16',drawnBall:'1',drawLabel:'1'}:numbered?{...result,drawLabel:result.drawnBall}:{...result,drawLabel:'?'};

  copy.textContent=numbered?`Gold 1 wins · round odds 1 in ${shown.ballCount}`:'Historical lottery result';

  let revealed=false;

  const reveal=()=>{

    if(generation!==presentation||revealed)return;

    revealed=true;stopAssets();

    dialog.dataset.reveal='presented';
    if(!preview)prizeScene?.show();

    title.textContent=preview?'Preview':result.isWinner?'Your prize':result.hit?'Prize awarded':'Jackpot rolls over';

    copy.textContent=numbered?`Ball ${shown.drawnBall} · round odds 1 in ${shown.ballCount}`:'Original draw rules';

    if(numbered&&BigInt(shown.ballCount)>BigInt(MAX_PHYSICAL_BALLS))status.textContent+=` · ${MAX_PHYSICAL_BALLS} of ${shown.ballCount} balls shown`;

    if(numbered&&shown.ballCount==='0'){title.textContent='Prize is building';copy.textContent='No funded draw this round';}

    if(!preview){

      const value=result.hit?result.paid:result.nextPrize;

      amount.textContent=money(value);amount.title=`${value} ETH`;

      dialog.querySelector('.lottery-amount-label').textContent=(result.hit?'Winner credited':'Next winner prize')+(result.testFunds?' · test ETH':'');

      if(!previewResult(result)&&numbered&&BigInt(shown.ballCount)>0n&&BigInt(result.roundStake)>0n){

        const {numerator,denominator}=playerLotteryOdds(result.myStake,result.roundStake,shown.ballCount);

        const odds=Number(numerator*10n**12n/denominator)/1e10;

        dialog.querySelector('.lottery-personal-odds').title=`Exact probability: ${numerator} / ${denominator}`;

        dialog.querySelector('.lottery-personal-odds').textContent=`Your chance this round: ${odds>0?'≈ '+odds.toLocaleString('en-US',{maximumSignificantDigits:4})+'%':'below 0.0000000001%'}. Exact: ${numerator} / ${denominator}. Losing crash bets also enter. Gas is extra.`;

      }

      if(result.isWinner){

        collect.hidden=!!result.collected;collect.textContent='Collect prize';

        status.textContent=result.collected?'Collected to your wallet':'Ready to collect';

        collect.onclick=()=>{

          collect.disabled=true;collect.textContent='Collecting…';

          document.dispatchEvent(new CustomEvent('plank:collect-lottery',{detail:{result,complete:outcome=>{

            if(outcome.ok)result.collected=true;

            if(generation!==presentation)return;

            collect.disabled=false;

            if(outcome.ok){result.collected=true;collect.hidden=true;status.textContent='Collected to your wallet';dialog.dataset.collected='true';returnTimer=setTimeout(close,3000);}

            else{collect.textContent='Try again';status.textContent=outcome.message||'Collection failed. Try again.';}

          }}}));

        };

      }else if(result.hit)status.textContent='Credited to the winning wallet';

      // Finish the presentation; never place the next bet automatically.

      if(!result.isWinner)returnTimer=setTimeout(close,2500);

    }

    document.dispatchEvent(new CustomEvent('plank:lottery-presented',{detail:{roundId:result?.roundId||null,preview,ball:shown.drawnBall}}));

  };

  if(result&&result.verified!==true){open();host.replaceChildren();title.textContent='Checking result';copy.textContent='Reconnect to verify this draw.';status.textContent='Payout display paused';return;}

  if(numbered&&shown.ballCount==='0'){open();host.innerHTML='<svg class="lottery-funding-icon" viewBox="0 0 160 160" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="4"><path d="M48 40h64v14c17 14 26 36 26 59 0 18-14 27-58 27s-58-9-58-27c0-23 9-45 26-59Z"/><path d="M52 28h56M50 48h60M80 68l-17 27 17 11 17-11-17-27Zm-17 35 17 24 17-24"/></svg>';reveal();return;}

  const fallback=()=>{

    if(generation!==presentation||revealed)return;

    dispose?.();dispose=null;open();

    const ball=document.createElement('div');ball.className='lottery-static-ball';ball.textContent=shown.drawnBall||'?';host.replaceChildren(ball);

    reveal();status.textContent+=' · Verified result';

  };

  canvas.addEventListener('lottery-render-error',fallback,{once:true});

  // Resource failures must not hold a verified result or the story queue forever.

  assetTimer=setTimeout(fallback,10000);

  try{if(cached){cached.reveal=reveal;cached.open=open;dispose=cached.dispose;if(cached.ready)open();dispose.start(scheduled?result?.revealNotBefore:null);}else dispose=mountLotteryMachine(canvas,{result:shown,startAt:scheduled?result?.revealNotBefore:null,onPrepared:open,onReady:reveal});}catch{fallback();}



}

document.addEventListener('plank:lottery-result',event=>{

  lastResult=event.detail;clearTimeout(revealTimer);preparePrize(lastResult);
  if(event.detail.verified===true)prepareScene(event.detail);

  // Let the crash's fireworks finish before taking over the playfield.

  // This delay never changes chain deadlines, randomness, or credited payouts.

    if(event.detail.participated||event.detail.spectatorShow){

    const result=event.detail;

    revealTimer=setTimeout(()=>{if(lastResult===result)show(result,true);},lotteryDelay(result.revealNotBefore,performance.now(),matchMedia('(prefers-reduced-motion: reduce)').matches));

  }

});

const button=document.createElement('button');button.className='lottery-open';button.textContent='◉';button.setAttribute('aria-label','Open lottery machine');

button.addEventListener('click',()=>show(lastResult));document.querySelector('.topbar').append(button);


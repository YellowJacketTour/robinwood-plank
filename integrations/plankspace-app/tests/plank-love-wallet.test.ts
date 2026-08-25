import assert from "node:assert/strict";
import test from "node:test";

class TestCustomEvent<T=unknown> extends Event {
  detail:T;
  constructor(type:string,init:{detail:T}){super(type);this.detail=init.detail}
}

test("delegates connection and signing to the mounted Plank.love wallet provider", async () => {
  const sent:Array<{requestId:string;method:string;payload?:Record<string,unknown>}>=[];
  const windowTarget=new EventTarget() as EventTarget&typeof globalThis;
  Object.assign(windowTarget,{setTimeout,clearTimeout});
  const storage=new Map<string,string>();
  const localStorage={getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)};
  Object.assign(globalThis,{window:windowTarget,CustomEvent:TestCustomEvent,localStorage});

  windowTarget.addEventListener("plank:wallet-request",raw=>{
    const detail=(raw as TestCustomEvent<{requestId:string;method:string;payload?:Record<string,unknown>}>).detail;
    sent.push(detail);
    const result=detail.method==="getState"?{state:{address:null,chainId:null,status:"disconnected",isConnected:false}}:detail.method==="connect"?{address:"0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d"}:detail.method==="signMessage"?{signature:"0xsigned"}:{};
    queueMicrotask(()=>windowTarget.dispatchEvent(new TestCustomEvent("plank:wallet-response",{detail:{requestId:detail.requestId,result}})));
  });

  const wallet=await import("../app/plank-love-wallet");
  assert.equal(await wallet.connectPlankLoveWallet(),"0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d");
  assert.deepEqual(sent.map(item=>item.method),["getState","connect"]);

  const message="PlankSpace wallet verification\nSite: https://plank.love/plankspace\nSafety: This is only a login signature and cannot move funds.";
  assert.equal(await wallet.signPlankLoveMessage(message,"0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d"),"0xsigned");
  assert.equal(sent.at(-1)?.method,"signMessage");
});

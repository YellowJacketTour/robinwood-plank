import type {MovementSnapshot,SequencedInput} from './input-reconciliation';

/** Region-worker building block, not yet connected to native Hero or an endpoint.
 * The caller authenticates admission and supplies its monotonic clock. One input
 * is exactly one simulation tick. Client timestamps never create tick credit. */
export function createInputAuthority<S,I>(options:{
 initial:MovementSnapshot<S>;nowMs:number;tickMs:number;maxCatchupTicks:number;maxBatch:number;
 step:(state:S,input:I)=>S;cloneState:(state:S)=>S;
 readInput:(raw:unknown)=>I;
}){
 const safe=(n:number)=>Number.isSafeInteger(n)&&n>=0;
 if(!safe(options.initial.epoch)||!safe(options.initial.ack)||!safe(options.initial.revision)||
  !Number.isFinite(options.nowMs)||options.nowMs<0||!Number.isFinite(options.tickMs)||options.tickMs<=0||
  !safe(options.maxCatchupTicks)||options.maxCatchupTicks<1||!safe(options.maxBatch)||options.maxBatch<1)throw new Error('Invalid authority configuration');
 let state=options.cloneState(options.initial.state),ack=options.initial.ack,revision=options.initial.revision;
 let checked=options.nowMs,credit=0;
 const snapshot=():MovementSnapshot<S>=>({epoch:options.initial.epoch,ack,revision,state:options.cloneState(state)});
 return {
  snapshot,
  accept(epoch:number,raw:unknown,nowMs:number):MovementSnapshot<S>{
   if(epoch!==options.initial.epoch)throw new Error('Wrong movement epoch');
   if(!Number.isFinite(nowMs)||nowMs<checked)throw new Error('Invalid authority clock');
   if(!Array.isArray(raw)||raw.length>options.maxBatch)throw new Error('Invalid input batch');
   let previous=-1;
   const commands:SequencedInput<I>[]=[];
   for(const value of raw){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>k!=='sequence'&&k!=='input')||!safe(value.sequence)||value.sequence<1||value.sequence<=previous)throw new Error('Invalid input sequence');
    previous=value.sequence;
    // Retransmitted prefix has already committed. It cannot execute again.
    if(value.sequence<=ack)continue;
    if(value.sequence!==ack+commands.length+1)throw new Error('Missing input sequence');
    commands.push({sequence:value.sequence,input:options.readInput(value.input)});
   }
   const available=Math.min(options.maxCatchupTicks,credit+(nowMs-checked)/options.tickMs);
   if(commands.length>available+1e-9)throw new Error('Input exceeds server time budget');
   if(commands.length&&!safe(revision+1))throw new Error('Snapshot revision exhausted');
   // Reduce privately: failed collision/rule validation cannot partly commit.
   let next=options.cloneState(state);
   for(const command of commands)next=options.step(next,command.input);
   state=next;checked=nowMs;credit=Math.max(0,available-commands.length);
   if(commands.length){ack=commands[commands.length-1].sequence;revision++;}
   return snapshot();
  },
 };
}

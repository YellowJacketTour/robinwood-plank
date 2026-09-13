/** Transport-independent prediction. Not wired to native Hero until movement
 * parity is proven. The reducer must be pure and return a fresh state: replay
 * must never settle inventory, emit sound, or apply economic effects. */
export type SequencedInput<I> = Readonly<{sequence:number;input:I}>;
export type MovementSnapshot<S> = Readonly<{epoch:number;ack:number;revision:number;state:S}>;
export function createInputReconciliation<S,I>(options:{
 initial:MovementSnapshot<S>;
 step:(state:S,input:I)=>S;
 cloneState:(state:S)=>S;
 cloneInput:(input:I)=>I;
 maxPending:number;
}){
 const validSequence=(n:number)=>Number.isSafeInteger(n)&&n>=0;
 const validSnapshot=(s:MovementSnapshot<S>)=>validSequence(s.epoch)&&validSequence(s.ack)&&validSequence(s.revision);
 if(!validSnapshot(options.initial)||!Number.isSafeInteger(options.maxPending)||options.maxPending<1)throw new Error('Invalid prediction configuration');
 let epoch=options.initial.epoch,ack=options.initial.ack,last=ack,revision=options.initial.revision;
 let predicted=options.cloneState(options.initial.state);
 let pending:SequencedInput<I>[]=[];
 const state=()=>options.cloneState(predicted);
 return {
  state,
  /** Backpressure is explicit. Never discard an input and pretend continuity. */
  predict(input:I):SequencedInput<I>|null{
   if(pending.length>=options.maxPending)return null;
   if(!Number.isSafeInteger(last+1))throw new Error('Input sequence exhausted');
   const saved=options.cloneInput(input);
   const next=options.step(options.cloneState(predicted),options.cloneInput(saved));
   const command={sequence:last+1,input:saved};
   predicted=next;last++;pending.push(command);
   return {sequence:command.sequence,input:options.cloneInput(saved)};
  },
  /** Ordered reliable transport can send these as bounded batches. It need not
   * await each command. The authoritative receiver must deduplicate sequences. */
  unacknowledged():SequencedInput<I>[] {return pending.map(p=>({sequence:p.sequence,input:options.cloneInput(p.input)}));},
  reconcile(snapshot:MovementSnapshot<S>):'accepted'|'stale'|'wrong-epoch'{
   if(!validSnapshot(snapshot))throw new Error('Invalid movement snapshot');
   if(snapshot.epoch!==epoch)return 'wrong-epoch';
   if(snapshot.revision<=revision||snapshot.ack<ack)return 'stale';
   if(snapshot.ack>last)throw new Error('Acknowledgment exceeds sent input');
   // A repeated ack may contain an authoritative impulse or collision change.
   // Replay later input over it rather than assigning its old position directly.
   const remaining=pending.filter(p=>p.sequence>snapshot.ack);
   let next=options.cloneState(snapshot.state);
   for(const p of remaining)next=options.step(next,options.cloneInput(p.input));
   predicted=next;pending=remaining;ack=snapshot.ack;revision=snapshot.revision;
   return 'accepted';
  },
  /** Explicit admission/warp only. Regular network snapshots cannot reset the
   * epoch or discard the outstanding input trail. */
  reset(snapshot:MovementSnapshot<S>){
   if(!validSnapshot(snapshot)||snapshot.epoch<=epoch)throw new Error('Reset requires a newer epoch');
   const next=options.cloneState(snapshot.state);
   epoch=snapshot.epoch;revision=snapshot.revision;ack=snapshot.ack;last=ack;predicted=next;pending=[];
  },
 };
}

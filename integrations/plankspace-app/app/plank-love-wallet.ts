"use client";

import {connectWallet,ensureRobinhoodChain,getChainId,getConnectedAccounts,signMessage} from "@/lib/wallet";

export type PlankLoveWalletState={address:string|null;chainId:number|null;status:"disconnected"|"connecting"|"connected";isConnected:boolean};
let state:PlankLoveWalletState={address:null,chainId:null,status:"disconnected",isConnected:false};
const listeners=new Set<(value:PlankLoveWalletState)=>void>();
function publish(next:PlankLoveWalletState){state=next;listeners.forEach(listener=>listener(next));return next}

export function subscribePlankLoveWalletState(listener:(value:PlankLoveWalletState)=>void){listeners.add(listener);listener(state);return()=>{listeners.delete(listener)}}
export async function getPlankLoveWalletState(){const address=(await getConnectedAccounts())[0]?.toLowerCase()||null;let chainId:number|null=null;if(address)chainId=await getChainId().catch(()=>null);return publish({address,chainId,status:address?"connected":"disconnected",isConnected:Boolean(address)})}
export async function connectPlankLoveWallet(){const existing=(await getConnectedAccounts())[0],address=(existing||await connectWallet()).toLowerCase();publish({address,chainId:await getChainId().catch(()=>null),status:"connected",isConnected:true});return address}
export async function ensurePlankLoveRobinhoodChain(){await ensureRobinhoodChain();return getPlankLoveWalletState()}
export async function signPlankLoveMessage(message:string,address:string){if(!message.startsWith("PlankSpace wallet verification\n")||message.length>2400)throw new Error("PlankSpace rejected an unknown signing request.");return signMessage(address,message)}
export async function disconnectPlankLoveWallet(){return publish({address:null,chainId:null,status:"disconnected",isConnected:false})}

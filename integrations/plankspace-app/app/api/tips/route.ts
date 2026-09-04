import { and, desc, eq } from "drizzle-orm";
import { formatEther } from "ethers";
import { getDb } from "../../../db";
import { profileTips, profiles, profileWidgets } from "../../../db/schema";

const cleanHandle=(v:string)=>v.toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,24);
const rpcFor=(chainId:number)=>({1:process.env.ETHEREUM_RPC_URL,8453:process.env.BASE_RPC_URL,42161:process.env.ARBITRUM_RPC_URL,46630:process.env.ROBINHOOD_CHAIN_RPC_URL||process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL}[chainId]||"");
async function rpc(url:string,method:string,params:unknown[]){const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),cache:"no-store"});if(!response.ok)throw new Error("Network verification failed");const body=await response.json() as {result?:unknown;error?:unknown};if(body.error)throw new Error("Network rejected verification");return body.result}

export async function GET(request:Request){const h=cleanHandle(new URL(request.url).searchParams.get("handle")||"");const rows=await getDb().select().from(profileTips).where(eq(profileTips.recipientHandle,h)).orderBy(desc(profileTips.verifiedAt)).limit(12);return Response.json({tips:rows.map(row=>({id:row.id,sender:row.publicSender?(row.senderHandle||`${row.senderWallet.slice(0,6)}…${row.senderWallet.slice(-4)}`):"Anonymous Plank",amount:row.amount,tokenSymbol:row.tokenSymbol,chainId:row.chainId,txHash:row.txHash,verifiedAt:row.verifiedAt}))})}

export async function POST(request:Request){
 const body=await request.json() as {handle?:string;senderWallet?:string;txHash?:string;publicSender?:boolean},h=cleanHandle(body.handle||""),sender=String(body.senderWallet||"").toLowerCase(),txHash=String(body.txHash||"").toLowerCase();
 if(!/^0x[a-f0-9]{40}$/.test(sender)||!/^0x[a-f0-9]{64}$/.test(txHash))return Response.json({error:"Invalid transaction proof"},{status:400});
 const db=getDb(),[profile]=await db.select().from(profiles).where(and(eq(profiles.handle,h),eq(profiles.moderationStatus,"approved"))).limit(1);
 if(!profile)return Response.json({error:"Recipient profile not found"},{status:404});
 const widgets=await db.select().from(profileWidgets).where(and(eq(profileWidgets.profileHandle,h),eq(profileWidgets.type,"tip-jar"),eq(profileWidgets.visible,true))).limit(1),config=widgets[0]?JSON.parse(widgets[0].configJson||"{}"):{};
 const recipient=String(config.recipient||"").toLowerCase(),chainId=Number(config.chainId||0),rpcUrl=rpcFor(chainId);
 if(!recipient||!rpcUrl)return Response.json({error:"This tip jar is not configured for a verifiable network"},{status:409});
 const [tx,receipt]=await Promise.all([rpc(rpcUrl,"eth_getTransactionByHash",[txHash]),rpc(rpcUrl,"eth_getTransactionReceipt",[txHash])]) as [Record<string,string>|null,Record<string,string>|null];
 if(!tx||!receipt||receipt.status!=="0x1"||tx.from?.toLowerCase()!==sender||tx.to?.toLowerCase()!==recipient||BigInt(tx.value||"0x0")<=0n)return Response.json({error:"The confirmed transaction does not match this tip jar"},{status:422});
 const amount=formatEther(BigInt(tx.value)),[senderProfile]=await db.select({handle:profiles.handle}).from(profiles).where(eq(profiles.wallet,sender)).limit(1);
 await db.insert(profileTips).values({recipientHandle:h,recipientWallet:recipient,senderWallet:sender,senderHandle:senderProfile?.handle||"",chainId,tokenSymbol:String(config.tokenSymbol||"NATIVE").slice(0,16),amount,txHash,publicSender:body.publicSender!==false}).onConflictDoNothing();
 return Response.json({verified:true,amount,txHash});
}

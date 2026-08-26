export async function GET(request:Request){
 const token=new URL(request.url).searchParams.get("token")?.trim()||"";
 if(!/^(?:0x[a-f0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,64})$/i.test(token))return Response.json({error:"Valid token contract or mint required"},{status:400});
 const response=await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(token)}`,{headers:{accept:"application/json"},next:{revalidate:60}});
 if(!response.ok)return Response.json({market:null});const body=await response.json() as {pairs?:Array<{priceUsd?:string;priceChange?:{h24?:number};url?:string;liquidity?:{usd?:number}}>};
 const pair=[...(body.pairs||[])].sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];return Response.json({market:pair?{priceUsd:pair.priceUsd||null,change24h:pair.priceChange?.h24??null,url:pair.url||null}:null});
}

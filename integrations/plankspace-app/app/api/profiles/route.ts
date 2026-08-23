import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { profileRelations, profiles, siteSettings } from "../../../db/schema";
import { hashJson } from "../auth/hash";
import { type Proof, verifyAndConsumeProof } from "../auth/verify";

const ADMIN_WALLET="0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d";
const SAWTOSHI_WALLET="0x7304b78e28370f45fdf77ca67bdbbf550c3aac34";
const SAWTOSHI_HANDLE="sawtoshiknotamoto";
const cleanHandle=(value:string)=>value.toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,24);
const text=(value:unknown,max:number)=>typeof value==="string"?value.trim().slice(0,max):"";
const youtubeUrls=(value:unknown)=>{const raw=text(value,4000);if(!raw)return "";const urls:string[]=[];for(const part of raw.split(/[\s,]+/)){try{const u=new URL(part),host=u.hostname.replace(/^www\./,"");let id="";if(host==="youtu.be")id=u.pathname.slice(1).split("/")[0];else if(host==="youtube.com"||host==="m.youtube.com"||host==="youtube-nocookie.com")id=u.searchParams.get("v")||(/^\/(embed|shorts)\//.test(u.pathname)?u.pathname.split("/")[2]:"");if(/^[\w-]{6,20}$/.test(id)){const canonical=`https://www.youtube.com/watch?v=${id}`;if(!urls.includes(canonical))urls.push(canonical)}}catch{}if(urls.length===8)break}return urls.join("\n")};
const avatarUrl=(value:unknown)=>{const raw=text(value,500);if(!raw)return "";try{const u=new URL(raw);return u.protocol==="https:"?u.toString():""}catch{return ""}};
const privateHost=/^(localhost|127\.|0\.|10\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|\[?::1\]?)/i;
async function cacheLayoutAssets(raw:string,_wallet:string){return raw.replace(/http:\/\//gi,"https://")}
export const publicProfile=(p:typeof profiles.$inferSelect)=>({id:p.id,handle:p.handle,displayName:p.displayName,bio:p.bio,hobbies:p.hobbies,interests:p.interests,music:p.music,heroes:p.heroes,lookingToMeet:p.lookingToMeet,avatarUrl:p.avatarUrl?`/api/avatar?handle=${p.handle}`:"",mood:p.mood,moodText:p.moodText,customHtml:p.customHtml,themeJson:p.themeJson,layoutJson:p.layoutJson,featuredVideo:p.featuredVideo,createdAt:p.createdAt,updatedAt:p.updatedAt});

export async function GET(request:Request){
 const params=new URL(request.url).searchParams,handle=cleanHandle(params.get("handle")||""),availability=cleanHandle(params.get("availability")||"");
 const db=getDb();
 if(availability){const [match]=await db.select({id:profiles.id}).from(profiles).where(eq(profiles.handle,availability)).limit(1);return Response.json({available:!match})}
 if(handle){const [profile]=await db.select().from(profiles).where(eq(profiles.handle,handle)).limit(1);return profile?.moderationStatus==="approved"?Response.json({profile:publicProfile(profile)}):Response.json({error:"Profile not found"},{status:404})}
 const items=await db.select({handle:profiles.handle,displayName:profiles.displayName,bio:profiles.bio,avatarUrl:profiles.avatarUrl,mood:profiles.mood,updatedAt:profiles.updatedAt}).from(profiles).where(eq(profiles.moderationStatus,"approved")).orderBy(desc(profiles.updatedAt)).limit(100);
 return Response.json({profiles:items.map(p=>({...p,avatarUrl:p.avatarUrl?`/api/avatar?handle=${p.handle}`:""}))});
}

export async function PUT(request:Request){
 const payload=await request.json() as Proof&{wallet?:string};
 const wallet=(payload.wallet||"").toLowerCase(),hash=await hashJson({wallet}),signed=await verifyAndConsumeProof(payload,"profile:read",wallet,hash);
 if(!signed)return Response.json({error:"Signed owner proof required"},{status:403});
 const [profile]=await getDb().select().from(profiles).where(eq(profiles.wallet,wallet)).limit(1);
 return profile?Response.json({profile}):Response.json({error:"Profile not found"},{status:404});
}

export async function POST(request:Request){
 const payload=await request.json() as Proof&{wallet?:string;handle?:string;profile?:Record<string,unknown>};
 const wallet=(payload.wallet||"").toLowerCase(),handle=cleanHandle(payload.handle||""),p=payload.profile||{};
 if(!/^0x[a-f0-9]{40}$/.test(wallet)||handle.length<3)return Response.json({error:"A valid wallet and 3–24 character username are required"},{status:400});
 const hash=await hashJson({handle,profile:p});
 const signed=await verifyAndConsumeProof(payload,"profile:save",handle,hash);
 if(!signed)return Response.json({error:"Signed ownership proof does not match these profile changes"},{status:403});
 const db=getDb(),[existing]=await db.select().from(profiles).where(eq(profiles.wallet,wallet)).limit(1);
 if(existing&&existing.handle!==handle)return Response.json({error:"Usernames are permanent so profile links and comments never break"},{status:409});
 const [handleOwner]=await db.select().from(profiles).where(eq(profiles.handle,handle)).limit(1);
 if(handleOwner&&handleOwner.wallet!==wallet)return Response.json({error:"That username is already taken"},{status:409});
 let previousLayout:string[]=[];try{previousLayout=JSON.parse(existing?.layoutJson||"[]")}catch{}
 const layout=Array.isArray(p.layout)?p.layout.filter(v=>typeof v==="string").slice(0,20):previousLayout;
 let savedAvatar=avatarUrl(p.avatarUrl)||existing?.avatarUrl||"";const upload=typeof p.avatarData==="string"?p.avatarData:"",match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(upload);if(match){const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));if(bytes.length>2_000_000)return Response.json({error:"Profile picture must be under 2 MB"},{status:413});savedAvatar=upload}
 const rawTheme:Record<string,unknown>=p.themeJson&&typeof p.themeJson==="object"?p.themeJson as Record<string,unknown>:{},hex=(v:unknown,fallback:string)=>/^#[0-9a-f]{6}$/i.test(String(v))?String(v):fallback,fonts=new Set(["Verdana","Georgia","Arial","Courier New"]),templates=new Set(["lounge","classic","midnight","neon"]),moduleIds=new Set(["welcome","status","music","video","game","custom","collection","about","friends","feed","comments"]),rawVisibility=rawTheme.moduleVisibility&&typeof rawTheme.moduleVisibility==="object"?rawTheme.moduleVisibility as Record<string,unknown>:{},moduleVisibility=Object.fromEntries([...moduleIds].map(id=>[id,rawVisibility[id]!==false])),duration=Number(rawTheme.gameDuration),theme={template:templates.has(String(rawTheme.template))?String(rawTheme.template):"lounge",pageBackground:hex(rawTheme.pageBackground,"#24130b"),panelBackground:hex(rawTheme.panelBackground,"#f2dfbe"),textColor:hex(rawTheme.textColor,"#2b160d"),linkColor:hex(rawTheme.linkColor,"#6e2b0e"),headingColor:hex(rawTheme.headingColor,"#fff0cf"),accentColor:hex(rawTheme.accentColor,"#e4862a"),fontFamily:fonts.has(String(rawTheme.fontFamily))?String(rawTheme.fontFamily):"Verdana",showTop8:rawTheme.showTop8!==false,moduleVisibility,gameTitle:text(rawTheme.gameTitle,40)||"PLANK ATTACK!",gameDuration:[10,20,30].includes(duration)?duration:20};
 const [autoSetting]=await db.select({value:siteSettings.value}).from(siteSettings).where(eq(siteSettings.key,"auto_approve_profiles")).limit(1),autoApprove=autoSetting?.value==="true",isAdmin=wallet===ADMIN_WALLET||wallet===SAWTOSHI_WALLET;
 const customHtml=await cacheLayoutAssets(text(p.customHtml,20000),wallet),values={handle,displayName:text(p.displayName,40)||existing?.displayName||handle,bio:text(p.bio,500),hobbies:text(p.hobbies,500),interests:text(p.interests,500),music:text(p.music,500),heroes:text(p.heroes,500),lookingToMeet:text(p.lookingToMeet,500),avatarUrl:savedAvatar,mood:text(p.mood,40)||"feeling board",moodText:text(p.moodText,140)||"holding down the lumberyard.",customHtml,themeJson:JSON.stringify(theme),layoutJson:JSON.stringify(layout).slice(0,4000),featuredVideo:youtubeUrls(p.featuredVideo),moderationStatus:existing?.moderationStatus||(isAdmin||autoApprove?"approved":"pending")};
 await db.insert(profiles).values({wallet,...values}).onConflictDoUpdate({target:profiles.wallet,set:{...values,updatedAt:new Date().toISOString()}});
 if(wallet!==ADMIN_WALLET){
  await db.insert(profileRelations).values({ownerWallet:wallet,targetHandle:"degenwaffle",kind:"friend",rank:0}).onConflictDoNothing();
  await db.insert(profileRelations).values({ownerWallet:ADMIN_WALLET,targetHandle:handle,kind:"friend",rank:0}).onConflictDoNothing();
 }
 if(wallet!==SAWTOSHI_WALLET){
  await db.insert(profileRelations).values({ownerWallet:wallet,targetHandle:SAWTOSHI_HANDLE,kind:"friend",rank:0}).onConflictDoNothing();
  await db.insert(profileRelations).values({ownerWallet:SAWTOSHI_WALLET,targetHandle:handle,kind:"friend",rank:0}).onConflictDoNothing();
 }
 const [profile]=await db.select().from(profiles).where(eq(profiles.wallet,wallet)).limit(1);
 return Response.json({profile});
}

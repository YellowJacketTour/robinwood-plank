import { desc, eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../../../db";
import { profileRelations, profiles, siteSettings } from "../../../db/schema";
import { hasOwnerSession, OWNER_WALLET } from "../../owner-access-auth";
import { getDelegatedAdminWallet, SAWTOSHI_WALLET } from "../../admin-access-auth";
import { hashJson } from "../auth/hash";
import { type Proof, verifyAndConsumeProof } from "../auth/verify";

const ADMIN_WALLET="0x269a93ec8486fbc3a82e352430e84fd8af8ebb0d";
const SAWTOSHI_HANDLE="sawtoshiknotamoto";
const cleanHandle=(value:string)=>value.toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,24);
const text=(value:unknown,max:number)=>typeof value==="string"?value.trim().slice(0,max):"";
const youtubeUrl=(value:unknown)=>{const raw=text(value,500);if(!raw)return "";try{const u=new URL(raw),host=u.hostname.replace(/^www\./,"");let id="";if(host==="youtu.be")id=u.pathname.slice(1).split("/")[0];else if(host==="youtube.com"||host==="m.youtube.com")id=u.searchParams.get("v")||(/^\/embed\//.test(u.pathname)?u.pathname.split("/")[2]:"");return /^[\w-]{6,20}$/.test(id)?`https://www.youtube.com/watch?v=${id}`:""}catch{return ""}};
const avatarUrl=(value:unknown)=>{const raw=text(value,500);if(!raw)return "";try{const u=new URL(raw);return u.protocol==="https:"?u.toString():""}catch{return ""}};
const privateHost=/^(localhost|127\.|0\.|10\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|\[?::1\]?)/i;
async function cacheLayoutAssets(raw:string,wallet:string){let html=raw;const urls=[...new Set([...raw.matchAll(/url\s*\(\s*(['"]?)(https?:\/\/.*?)\1\s*\)/gi)].map(m=>m[2]).slice(0,4))];for(const original of urls){try{const upgraded=original.replace(/^http:/i,"https:"),u=new URL(upgraded);if(privateHost.test(u.hostname))continue;const response=await fetch(upgraded,{signal:AbortSignal.timeout(7000),headers:{accept:"image/*"}}),type=response.headers.get("content-type")||"",length=Number(response.headers.get("content-length")||0);if(!response.ok||!type.startsWith("image/")||length>3_000_000)continue;const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>3_000_000)continue;const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(upgraded)),hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("").slice(0,24),key=`layout-assets/${wallet}/${hash}`;await (env as typeof env&{BUCKET:R2Bucket}).BUCKET.put(key,bytes,{httpMetadata:{contentType:type}});html=html.split(original).join(`/api/layout-asset?key=${key}`)}catch{}}return html}
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
 const ownerBypass=await hasOwnerSession(request),delegated=await getDelegatedAdminWallet(request),requested=(payload.wallet||"").toLowerCase(),wallet=ownerBypass?OWNER_WALLET:requested||delegated||"",hash=await hashJson({wallet}),signed=ownerBypass?null:await verifyAndConsumeProof(payload,"profile:read",wallet,hash),delegatedBypass=Boolean(!signed&&delegated&&wallet===SAWTOSHI_WALLET);
 if(!ownerBypass&&!signed&&!delegatedBypass)return Response.json({error:"Signed owner proof required"},{status:403});
 const [profile]=await getDb().select().from(profiles).where(eq(profiles.wallet,wallet)).limit(1);
 return profile?Response.json({profile}):Response.json({error:"Profile not found"},{status:404});
}

export async function POST(request:Request){
 const payload=await request.json() as Proof&{wallet?:string;handle?:string;profile?:Record<string,unknown>};
 const ownerBypass=await hasOwnerSession(request),delegated=await getDelegatedAdminWallet(request),requested=(payload.wallet||"").toLowerCase(),wallet=ownerBypass?OWNER_WALLET:requested||delegated||"",handle=cleanHandle(payload.handle||""),p=payload.profile||{};
 if(!/^0x[a-f0-9]{40}$/.test(wallet)||handle.length<3)return Response.json({error:"A valid wallet and 3–24 character username are required"},{status:400});
 if(ownerBypass&&wallet!==OWNER_WALLET)return Response.json({error:"Owner shortcut is limited to DegenWaffle"},{status:403});
 const hash=await hashJson({handle,profile:p});
 const signed=ownerBypass?null:await verifyAndConsumeProof(payload,"profile:save",handle,hash),delegatedBypass=Boolean(!signed&&delegated&&wallet===SAWTOSHI_WALLET&&handle==="sawtoshiknotamoto");
 if(!ownerBypass&&!signed&&!delegatedBypass)return Response.json({error:"Signed ownership proof does not match these profile changes"},{status:403});
 const db=getDb(),[existing]=await db.select().from(profiles).where(eq(profiles.wallet,wallet)).limit(1);
 if(existing&&existing.handle!==handle)return Response.json({error:"Usernames are permanent so profile links and comments never break"},{status:409});
 const [handleOwner]=await db.select().from(profiles).where(eq(profiles.handle,handle)).limit(1);
 if(handleOwner&&handleOwner.wallet!==wallet)return Response.json({error:"That username is already taken"},{status:409});
 let previousLayout:string[]=[];try{previousLayout=JSON.parse(existing?.layoutJson||"[]")}catch{}
 const layout=Array.isArray(p.layout)?p.layout.filter(v=>typeof v==="string").slice(0,20):previousLayout;
 let savedAvatar=avatarUrl(p.avatarUrl)||existing?.avatarUrl||"";const upload=typeof p.avatarData==="string"?p.avatarData:"",match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(upload);if(match){const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));if(bytes.length>2_000_000)return Response.json({error:"Profile picture must be under 2 MB"},{status:413});const key=`avatars/${wallet}.${match[1]==="jpeg"?"jpg":match[1]}`;await (env as typeof env&{BUCKET:R2Bucket}).BUCKET.put(key,bytes,{httpMetadata:{contentType:`image/${match[1]}`}});savedAvatar=`r2:${key}`}else if(savedAvatar.startsWith("https://")&&savedAvatar!==existing?.avatarUrl){try{const u=new URL(savedAvatar);if(privateHost.test(u.hostname))throw new Error();const response=await fetch(u,{signal:AbortSignal.timeout(7000),headers:{accept:"image/*"}}),type=response.headers.get("content-type")||"",length=Number(response.headers.get("content-length")||0);if(!response.ok||!type.startsWith("image/")||length>2_000_000)throw new Error();const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>2_000_000)throw new Error();const ext=type.includes("png")?"png":type.includes("jpeg")?"jpg":"webp",key=`avatars/${wallet}.${ext}`;await (env as typeof env&{BUCKET:R2Bucket}).BUCKET.put(key,bytes,{httpMetadata:{contentType:type}});savedAvatar=`r2:${key}`}catch{return Response.json({error:"That profile image could not be safely imported. Upload the file instead."},{status:400})}}
 const rawTheme=p.themeJson&&typeof p.themeJson==="object"?p.themeJson:{},hex=(v:unknown,fallback:string)=>/^#[0-9a-f]{6}$/i.test(String(v))?String(v):fallback,fonts=new Set(["Verdana","Georgia","Arial","Courier New"]),templates=new Set(["lounge","classic","midnight","neon"]),theme={template:templates.has(String(rawTheme.template))?String(rawTheme.template):"lounge",pageBackground:hex(rawTheme.pageBackground,"#24130b"),panelBackground:hex(rawTheme.panelBackground,"#f2dfbe"),textColor:hex(rawTheme.textColor,"#2b160d"),linkColor:hex(rawTheme.linkColor,"#6e2b0e"),headingColor:hex(rawTheme.headingColor,"#fff0cf"),accentColor:hex(rawTheme.accentColor,"#e4862a"),fontFamily:fonts.has(String(rawTheme.fontFamily))?String(rawTheme.fontFamily):"Verdana",showTop8:rawTheme.showTop8!==false};
 const [autoSetting]=await db.select({value:siteSettings.value}).from(siteSettings).where(eq(siteSettings.key,"auto_approve_profiles")).limit(1),autoApprove=autoSetting?.value==="true",isAdmin=wallet===ADMIN_WALLET||wallet===SAWTOSHI_WALLET;
 const customHtml=await cacheLayoutAssets(text(p.customHtml,20000),wallet),values={handle,displayName:text(p.displayName,40)||existing?.displayName||handle,bio:text(p.bio,500),hobbies:text(p.hobbies,500),interests:text(p.interests,500),music:text(p.music,500),heroes:text(p.heroes,500),lookingToMeet:text(p.lookingToMeet,500),avatarUrl:savedAvatar,mood:text(p.mood,40)||"feeling board",moodText:text(p.moodText,140)||"holding down the lumberyard.",customHtml,themeJson:JSON.stringify(theme),layoutJson:JSON.stringify(layout).slice(0,4000),featuredVideo:youtubeUrl(p.featuredVideo),moderationStatus:existing?.moderationStatus||(isAdmin||autoApprove?"approved":"pending")};
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

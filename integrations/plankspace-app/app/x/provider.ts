export type XAccount = { id:string; username:string; accessToken:string; refreshToken?:string; expiresAt?:string };
export type XPost = { id:string; text:string; createdAt:string; url:string };
type FetchLike = (input:string|URL,init?:RequestInit)=>Promise<Response>;

export const PLANKSPACE_X_FOOTER="Posted from my PlankSpace on Plank.Love";
export function formatPlankSpaceXPost(text:string):string{const suffix=`\n\n${PLANKSPACE_X_FOOTER}`,available=280-Array.from(suffix).length,source=Array.from(text.trim()),body=source.length<=available?source.join(""):`${source.slice(0,Math.max(0,available-1)).join("").trimEnd()}…`;return `${body}${suffix}`}

async function responseJson(response:Response):Promise<Record<string,unknown>>{const text=await response.text();if(!text)return{};try{return JSON.parse(text) as Record<string,unknown>}catch{return{}}}
function failure(operation:string,response:Response,body:Record<string,unknown>){const detail=typeof body.detail==="string"?body.detail:typeof body.title==="string"?body.title:"";return new Error(`${operation} (${response.status})${detail?`: ${detail}`:""}`)}

export interface XProvider{connect(input:{handle:string;code?:string;verifier?:string}):Promise<XAccount>;listRecentPosts(account:XAccount,cursor:string):Promise<{posts:XPost[];cursor:string}>;createPost(account:XAccount,text:string,idempotencyKey:string):Promise<XPost>;createPostIfRequested(account:XAccount,text:string,idempotencyKey:string,requested:boolean):Promise<XPost|null>}

export class DevelopmentXProvider implements XProvider{
 async connect():Promise<XAccount>{return{id:"xdev-degen_waffle",username:"Degen_Waffle",accessToken:"development-degen_waffle"}}
 async listRecentPosts(account:XAccount,cursor:string){if(cursor)return{posts:[],cursor};const posts=["Connected X to my PlankSpace.","PLANK IS FOR THE PEOPLE 🪵"].map((text,index)=>({id:`xdev-import-${account.username}-${index+1}`,text,createdAt:new Date(Date.now()-(index+1)*60_000).toISOString(),url:`https://x.com/${account.username}/status/xdev-import-${index+1}`}));return{posts,cursor:"development-complete"}}
 async createPost(account:XAccount,text:string,idempotencyKey:string):Promise<XPost>{const id=`xdev-${idempotencyKey}`,sharedText=formatPlankSpaceXPost(text);return{id,text:sharedText,createdAt:new Date().toISOString(),url:`https://x.com/${account.username}/status/${id}`}}
 async createPostIfRequested(account:XAccount,text:string,idempotencyKey:string,requested:boolean){return requested?this.createPost(account,text,idempotencyKey):null}
}

export class LiveXProvider implements XProvider{
 constructor(private readonly fetchImpl:FetchLike=fetch){}
 async connect():Promise<XAccount>{throw new Error("Live X OAuth must complete through the callback route")}
 async listRecentPosts(account:XAccount,cursor:string){const url=new URL(`https://api.x.com/2/users/${account.id}/tweets`);url.searchParams.set("max_results","20");url.searchParams.set("tweet.fields","created_at");if(cursor)url.searchParams.set("pagination_token",cursor);const response=await this.fetchImpl(url,{headers:{authorization:`Bearer ${account.accessToken}`}}),body=await responseJson(response) as {data?:Array<{id:string;text:string;created_at?:string}>;meta?:{next_token?:string}};if(!response.ok)throw failure("X timeline request failed",response,body);return{posts:(body.data||[]).map(post=>({id:post.id,text:post.text,createdAt:post.created_at||new Date().toISOString(),url:`https://x.com/${account.username}/status/${post.id}`})),cursor:body.meta?.next_token||cursor}}
 async createPost(account:XAccount,text:string,idempotencyKey:string){const sharedText=formatPlankSpaceXPost(text),response=await this.fetchImpl("https://api.x.com/2/tweets",{method:"POST",headers:{authorization:`Bearer ${account.accessToken}`,"content-type":"application/json","idempotency-key":idempotencyKey},body:JSON.stringify({text:sharedText})}),body=await responseJson(response) as {data?:{id:string;text:string}};if(!response.ok||!body.data)throw failure("X post publication failed",response,body);return{id:body.data.id,text:body.data.text,createdAt:new Date().toISOString(),url:`https://x.com/${account.username}/status/${body.data.id}`}}
 async createPostIfRequested(account:XAccount,text:string,idempotencyKey:string,requested:boolean){return requested?this.createPost(account,text,idempotencyKey):null}
}

export function selectXProvider({mode=process.env.PLANKSPACE_X_PROVIDER||"live",nodeEnv=process.env.NODE_ENV||"development"}:{mode?:string;nodeEnv?:string}={}):XProvider{if(mode==="development"){if(nodeEnv==="production")throw new Error("Development X provider is disabled in production");return new DevelopmentXProvider()}return new LiveXProvider()}
export const getXProvider=()=>selectXProvider();

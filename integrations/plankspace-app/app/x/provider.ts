export type XAccount={id:string;username:string;accessToken:string;refreshToken?:string;expiresAt?:string};
export type XPost={id:string;text:string;createdAt:string;url:string};
export interface XProvider{connect(input:{handle:string;code?:string;verifier?:string}):Promise<XAccount>;listRecentPosts(account:XAccount,cursor:string):Promise<{posts:XPost[];cursor:string}>;createPost(account:XAccount,text:string,idempotencyKey:string):Promise<XPost>;createPostIfRequested(account:XAccount,text:string,idempotencyKey:string,requested:boolean):Promise<XPost|null>}

export class DevelopmentXProvider implements XProvider{
 async connect():Promise<XAccount>{const username="Degen_Waffle";return{id:"xdev-degen_waffle",username,accessToken:"development-degen_waffle"}}
 async listRecentPosts(account:XAccount,cursor:string){if(cursor)return{posts:[],cursor};const posts=["Connected X to my PlankSpace.","PLANK IS FOR THE PEOPLE 🪵"].map((text,index)=>({id:`xdev-import-${account.username}-${index+1}`,text,createdAt:new Date(Date.now()-(index+1)*60_000).toISOString(),url:`https://x.com/${account.username}/status/xdev-import-${index+1}`}));return{posts,cursor:"development-complete"}}
 async createPost(account:XAccount,text:string,idempotencyKey:string):Promise<XPost>{const id=`xdev-${idempotencyKey}`;return{id,text,createdAt:new Date().toISOString(),url:`https://x.com/${account.username}/status/${id}`}}
 async createPostIfRequested(account:XAccount,text:string,idempotencyKey:string,requested:boolean){return requested?this.createPost(account,text,idempotencyKey):null}
}

class LiveXProvider implements XProvider{
 async connect():Promise<XAccount>{throw new Error("Live X OAuth must complete through the callback route")}
 async listRecentPosts(account:XAccount,cursor:string){const url=new URL(`https://api.x.com/2/users/${account.id}/tweets`);url.searchParams.set("max_results","20");url.searchParams.set("tweet.fields","created_at");if(cursor)url.searchParams.set("pagination_token",cursor);const response=await fetch(url,{headers:{authorization:`Bearer ${account.accessToken}`}}),body=await response.json() as {data?:Array<{id:string;text:string;created_at?:string}>;meta?:{next_token?:string}};if(!response.ok)throw new Error("X timeline request failed");return{posts:(body.data||[]).map(post=>({id:post.id,text:post.text,createdAt:post.created_at||new Date().toISOString(),url:`https://x.com/${account.username}/status/${post.id}`})),cursor:body.meta?.next_token||cursor}}
 async createPost(account:XAccount,text:string,idempotencyKey:string){const response=await fetch("https://api.x.com/2/tweets",{method:"POST",headers:{authorization:`Bearer ${account.accessToken}`,"content-type":"application/json","idempotency-key":idempotencyKey},body:JSON.stringify({text})}),body=await response.json() as {data?:{id:string;text:string}};if(!response.ok||!body.data)throw new Error("X post publication failed");return{id:body.data.id,text:body.data.text,createdAt:new Date().toISOString(),url:`https://x.com/${account.username}/status/${body.data.id}`}}
 async createPostIfRequested(account:XAccount,text:string,idempotencyKey:string,requested:boolean){return requested?this.createPost(account,text,idempotencyKey):null}
}

export function selectXProvider({mode=process.env.PLANKSPACE_X_PROVIDER||"live",nodeEnv=process.env.NODE_ENV||"development"}:{mode?:string;nodeEnv?:string}={}):XProvider{if(mode==="development"){if(nodeEnv==="production")throw new Error("Development X provider is disabled in production");return new DevelopmentXProvider()}return new LiveXProvider()}
export const getXProvider=()=>selectXProvider();

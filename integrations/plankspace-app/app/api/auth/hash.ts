export async function hashJson(value:unknown){
 const bytes=new TextEncoder().encode(JSON.stringify(value));
 const digest=await crypto.subtle.digest("SHA-256",bytes);
 return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}

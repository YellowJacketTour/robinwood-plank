type Environment=Record<string,string|undefined>;
/** Development-only acceptance gate. A protocol request cannot enable supply. */
export function localHeartSocialPolicy(request: Request, env:Environment=process.env) {
 const url=new URL(request.url);
 if(env.NODE_ENV!=='development'||env.CHARMVILLE_LOCAL_HEART_SOCIAL!=='1'||url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||request.headers.get('x-charmville-social-protocol')!=='social-items-v2')return undefined;
 return {burningHeart:true,clientProtocol:'social-items-v2'} as const;
}

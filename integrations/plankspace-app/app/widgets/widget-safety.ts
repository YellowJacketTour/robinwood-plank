import { WIDGET_TYPES, defaultWidgetStyle, type ProfileWidget, type WidgetType } from "./widget-types";

const text=(value:unknown,max=300)=>typeof value==="string"?value.trim().slice(0,max):"";
const hex=(value:unknown,fallback:string)=>/^#[0-9a-f]{6}$/i.test(String(value))?String(value):fallback;
const evm=(value:unknown)=>/^0x[a-f0-9]{40}$/i.test(String(value))?String(value).toLowerCase():"";
const https=(value:unknown)=>{try{const u=new URL(text(value,800));return u.protocol==="https:"?u.toString():""}catch{return ""}};
const cleanHtml=(value:unknown)=>text(value,12000)
  .replace(/<script[\s\S]*?<\/script>/gi,"")
  .replace(/<\/?(?:iframe|object|embed|form|input|button|meta|base|link)[\s\S]*?>/gi,"")
  .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,"")
  .replace(/javascript:/gi,"");
const cleanCss=(value:unknown)=>text(value,12000)
  .replace(/@import[^;]+;?/gi,"")
  .replace(/(?:javascript:|expression\s*\(|behavior\s*:|url\s*\(\s*['"]?(?!https:\/\/|data:image\/))/gi,"");

export function sanitizeWidget(raw: unknown, index: number): ProfileWidget | null {
  const input=(raw&&typeof raw==="object"?raw:{}) as Record<string,unknown>;
  if(!WIDGET_TYPES.includes(input.type as WidgetType))return null;
  const type=input.type as WidgetType,c=(input.config&&typeof input.config==="object"?input.config:{}) as Record<string,unknown>;
  let config:Record<string,unknown>={};
  if(type==="wallet") config={addresses:Array.isArray(c.addresses)?c.addresses.slice(0,8).map(a=>{const x=(a&&typeof a==="object"?a:{}) as Record<string,unknown>;return {chain:text(x.chain,30),label:text(x.label,40),address:text(x.address,120)}}).filter(x=>x.address):[]};
  if(type==="favorite-token") config={chain:text(c.chain,30),contract:text(c.contract,120),name:text(c.name,60),symbol:text(c.symbol,16),logoUrl:https(c.logoUrl),message:text(c.message,240)};
  if(type==="token-chart") config={provider:c.provider==="dextools"?"dextools":"dexscreener",url:text(c.url,800)};
  if(type==="portfolio") { const mode=["hidden","assets","allocation","full"].includes(String(c.mode))?String(c.mode):"hidden"; config={mode,wallets:Array.isArray(c.wallets)?c.wallets.slice(0,6).map(w=>{const x=(w&&typeof w==="object"?w:{}) as Record<string,unknown>;return {chain:text(x.chain,30),address:text(x.address,120)}}).filter(x=>x.address):[],assets:Array.isArray(c.assets)?c.assets.slice(0,24).map(a=>{const x=(a&&typeof a==="object"?a:{}) as Record<string,unknown>;return {name:text(x.name,60),symbol:text(x.symbol,16),amount:text(x.amount,40),allocation:Math.max(0,Math.min(100,Number(x.allocation)||0)),value:text(x.value,40)}}).filter(x=>x.symbol):[]}; }
  if(type==="tip-jar") config={chainId:Math.max(1,Number(c.chainId)||1),chainLabel:text(c.chainLabel,30),tokenSymbol:text(c.tokenSymbol,16)||"NATIVE",recipient:evm(c.recipient),presets:Array.isArray(c.presets)?c.presets.slice(0,5).map(v=>text(v,24)).filter(v=>/^\d+(?:\.\d{1,18})?$/.test(v)):[],showRecent:c.showRecent!==false};
  if(type==="custom") config={html:cleanHtml(c.html),css:cleanCss(c.css)};
  const s=(input.style&&typeof input.style==="object"?input.style:{}) as Record<string,unknown>;
  return {id:typeof input.id==="number"?input.id:text(input.id,80)||`new-${index}`,type,title:text(input.title,80),config,style:{background:hex(s.background,defaultWidgetStyle.background),opacity:Math.max(.15,Math.min(1,Number(s.opacity)||1)),borderColor:hex(s.borderColor,defaultWidgetStyle.borderColor),borderWidth:Math.max(0,Math.min(8,Number(s.borderWidth)||0)),borderRadius:Math.max(0,Math.min(32,Number(s.borderRadius)||0))},sortOrder:index,visible:input.visible!==false,desktopVisible:input.desktopVisible!==false,mobileVisible:input.mobileVisible!==false};
}

export function safeChartUrl(raw:unknown){const value=String(raw||"").trim();if(/^[a-z0-9_-]+\/[a-z0-9]+$/i.test(value))return `https://dexscreener.com/${value}?embed=1`;try{const u=new URL(value),host=u.hostname.replace(/^www\./,"");if(host==="dexscreener.com"&&/^\/[a-z0-9_-]+\/[a-z0-9]+/i.test(u.pathname)){u.searchParams.set("embed","1");return u.toString()}if((host==="dextools.io"||host.endsWith(".dextools.io"))&&/^\/app\//.test(u.pathname))return u.toString();return ""}catch{return ""}}

import LiveLounge from "@/integrations/plankspace-app/app/woodstock/live-lounge";
export default async function LoungePage({params}:{params:Promise<{slug:string}>}){const {slug}=await params;return <LiveLounge slug={slug}/>} 

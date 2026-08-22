"use client";
import { useSyncExternalStore } from "react";
const subscribe=()=>()=>{};
export default function BridgeNotice(){const standalone=useSyncExternalStore(subscribe,()=>window.parent===window,()=>false);if(!standalone)return null;return <aside className="bridge-notice" role="note"><b>Viewing PlankSpace directly</b><span>Profiles are public here, but wallet actions open only from the PlankSpace tab inside Plank.love.</span><a href="https://plank.love" target="_top">Open Plank.love</a></aside>}

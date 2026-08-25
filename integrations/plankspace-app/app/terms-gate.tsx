"use client";

import {useEffect,useState} from "react";
import Link from "next/link";

const CONSENT_KEY="plankspace-terms-2026-08-22-v1";

function startProfileMusic(){
 const command=JSON.stringify({event:"command",func:"playVideo",args:[]});
 const play=()=>document.querySelectorAll<HTMLIFrameElement>(".video-frame iframe").forEach(frame=>frame.contentWindow?.postMessage(command,"*"));
 play();setTimeout(play,250);setTimeout(play,1000);
 window.dispatchEvent(new CustomEvent("plankspace:terms-accepted"));
}

export default function TermsGate(){
 const [open,setOpen]=useState(false),[confirmed,setConfirmed]=useState(false);
 useEffect(()=>{queueMicrotask(()=>{if(location.pathname!=="/terms"&&localStorage.getItem(CONSENT_KEY)!=="accepted")setOpen(true)})},[]);
 const accept=()=>{localStorage.setItem(CONSENT_KEY,"accepted");setOpen(false);startProfileMusic()};
 if(!open)return null;
 return <div className="terms-gate" role="dialog" aria-modal="true" aria-labelledby="terms-gate-title"><div className="terms-gate-card"><small>BEFORE YOU ENTER THE LUMBERYARD</small><h1 id="terms-gate-title">Adults only. Boards behave.</h1><p>PlankSpace is an 18+ wallet-connected social community. By entering, you certify that you are at least 18 years old and agree to the Terms of Use and community rules.</p><ul><li>No illegal, threatening, hateful, harassing, deceptive, doxxing, infringing, or malicious content.</li><li>You are responsible for your profile, custom code, posts, wallet security, and interactions.</li><li>Moderators may restrict or remove content and accounts to protect the community.</li><li>Wallet and collectible features are not financial advice, custody, or a promise of value.</li></ul><label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/> <span>I certify that I am 18 or older and accept the <Link href="/plankspace/terms" target="_blank" rel="noreferrer">Terms of Use</Link>.</span></label><button disabled={!confirmed} onClick={accept}>I&apos;m 18+ — Accept &amp; Enter</button><Link className="terms-leave" href="/">I do not accept</Link><small>Entering may start the profile owner&apos;s selected YouTube music. Playback remains controlled by your browser and the visible player.</small></div></div>;
}

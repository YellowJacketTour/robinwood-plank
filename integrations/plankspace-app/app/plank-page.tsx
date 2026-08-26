import type { ReactNode } from "react";
export default function PlankPage({title,intro,children}:{eyebrow?:string;title:string;intro:string;children:ReactNode}){return <div className="plank-page"><main><aside><h1>{title}</h1><p>{intro}</p></aside><section className="plank-page-content">{children}</section></main></div>}

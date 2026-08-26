import Link from "next/link";
import type { ReactNode } from "react";
import AdminNavLink from "./admin-nav-link";
const nav=[["/browse","Browse"],["/search","Search"],["/planks-list","Planks List"],["/woodstock","Woodstock"],["/board-mail","Board Mail"]];
const footer=[["/about","About"],["/board-safety","Board Safety"],["/plankspace/terms","Terms"],["/grain-policy","Grain Policy"],["/help","Help"]];
export default function PlankPage({eyebrow,title,intro,children}:{eyebrow:string;title:string;intro:string;children:ReactNode}){return <div className="plank-page"><header><Link className="brand" href="/plankspace">plank<span>space</span></Link><nav>{nav.map(([href,label])=><Link key={href} href={href}>{label}</Link>)}<AdminNavLink/></nav><div className="account"><Link href="/profile-editor">Edit Profile</Link></div></header><main><aside><small>{eyebrow}</small><h1>{title}</h1><p>{intro}</p></aside><section className="plank-page-content">{children}</section></main><footer><b>plankspace</b><nav>{footer.map(([href,label])=><Link key={href} href={href}>{label}</Link>)}</nav><small>© 2026 PlankSpace · Wallet ownership stays private by default.</small></footer></div>}

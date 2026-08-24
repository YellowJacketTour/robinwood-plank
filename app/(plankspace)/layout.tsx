import "@/integrations/plankspace-app/app/globals.css";
import "@/integrations/plankspace-app/app/woodstock/profile-live.css";
import TermsGate from "@/integrations/plankspace-app/app/terms-gate";
import {WoodstockLiveProvider} from "@/integrations/plankspace-app/app/woodstock/live-provider";
export default function NativePlankSpaceLayout({children}:{children:React.ReactNode}){return <WoodstockLiveProvider><div className="plankspace-native"><TermsGate/>{children}</div></WoodstockLiveProvider>}

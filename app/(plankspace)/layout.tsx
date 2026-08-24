import "@/integrations/plankspace-app/app/globals.css";
import "@/integrations/plankspace-app/app/widget-live.css";
import TermsGate from "@/integrations/plankspace-app/app/terms-gate";
import { LiveAudioProvider } from "@/integrations/plankspace-app/app/woodstock/live-provider";
export default function NativePlankSpaceLayout({children}:{children:React.ReactNode}){return <LiveAudioProvider><div className="plankspace-native"><TermsGate/>{children}</div></LiveAudioProvider>}

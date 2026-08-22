import "@/integrations/plankspace-app/app/globals.css";
import TermsGate from "@/integrations/plankspace-app/app/terms-gate";
export default function PlankSpaceLayout({children}:{children:React.ReactNode}){return <div className="plankspace-native"><TermsGate/>{children}</div>}

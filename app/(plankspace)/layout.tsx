import "@/integrations/plankspace-app/app/globals.css";
import "@/integrations/plankspace-app/app/widget-live.css";
import Nav from "@/components/Nav";
import TermsGate from "@/integrations/plankspace-app/app/terms-gate";
import PlankSpaceSubnav from "@/integrations/plankspace-app/app/plankspace-subnav";

export default function NativePlankSpaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Nav />
      <PlankSpaceSubnav />
      <div className="plankspace-native">
        <TermsGate />
        {children}
      </div>
    </>
  );
}

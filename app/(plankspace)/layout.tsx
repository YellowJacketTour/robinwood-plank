import "@/integrations/plankspace-app/app/globals.css";
import "@/integrations/plankspace-app/app/widget-live.css";
import "@/integrations/plankspace-app/app/lumberyard.css";
import type { Metadata } from "next";
import Nav from "@/components/Nav";
import { PLANKSPACE_DISCOVERABLE } from "@/lib/constants";
import TermsGate from "@/integrations/plankspace-app/app/terms-gate";
import PlankSpaceSubnav from "@/integrations/plankspace-app/app/plankspace-subnav";
import NativePlankSpaceWalletBridge from "@/components/plankspace/NativePlankSpaceWalletBridge";

export const metadata: Metadata = {
  robots: {
    index: PLANKSPACE_DISCOVERABLE,
    follow: PLANKSPACE_DISCOVERABLE,
  },
};

export default function NativePlankSpaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Nav />
      <PlankSpaceSubnav />
      <NativePlankSpaceWalletBridge />
      <div className="plankspace-native">
        <TermsGate />
        {children}
      </div>
    </>
  );
}

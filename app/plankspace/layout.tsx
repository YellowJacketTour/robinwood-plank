import "@/integrations/plankspace-app/app/globals.css";
import "@/integrations/plankspace-app/app/plankspace-subnav.css";
import "@/integrations/plankspace-app/app/lumberyard.css";
import type { Metadata } from "next";
import Nav from "@/components/Nav";
import { PLANKSPACE_DISCOVERABLE } from "@/lib/constants";
import TermsGate from "@/integrations/plankspace-app/app/terms-gate";
import PlankSpaceSubnav from "@/integrations/plankspace-app/app/plankspace-subnav";

export const metadata: Metadata = {
  robots: {
    index: PLANKSPACE_DISCOVERABLE,
    follow: PLANKSPACE_DISCOVERABLE,
  },
};

export default function PlankSpaceLayout({
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

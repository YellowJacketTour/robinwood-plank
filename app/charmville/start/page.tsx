import Nav from "@/components/Nav";
import AppBackdrop from "@/components/AppBackdrop";
import Start from "./start";
import NativePlankSpaceWalletBridge from "@/components/plankspace/NativePlankSpaceWalletBridge";

export const metadata = { title: "Begin your Charmville story" };

export default function CharmvilleStartPage() {
  return <div className="min-h-screen bg-wood-950"><Nav /><NativePlankSpaceWalletBridge /><AppBackdrop /><Start /></div>;
}



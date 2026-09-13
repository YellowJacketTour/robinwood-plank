import { notFound } from "next/navigation";
import NativePlankSpaceWalletBridge from "@/components/plankspace/NativePlankSpaceWalletBridge";
import { charmvilleAdmissionMode } from "@/lib/charmville/admission";
import Access from "./access";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your Charmville invitation", robots: { index: false, follow: false }, referrer: "no-referrer" as const };

export default function AccessPage() {
  if (charmvilleAdmissionMode() === "disabled") notFound();
  return <><NativePlankSpaceWalletBridge /><Access /></>;
}

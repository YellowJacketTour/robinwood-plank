import { notFound } from "next/navigation";
import NativePlankSpaceWalletBridge from "@/components/plankspace/NativePlankSpaceWalletBridge";
import { charmvilleAdmissionMode } from "@/lib/charmville/admission";
import InvitationAdmin from "./invitation-admin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Charmville invitation desk", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default function InvitationAdminPage() {
  if (charmvilleAdmissionMode() === "disabled") notFound();
  return <><NativePlankSpaceWalletBridge /><InvitationAdmin /></>;
}

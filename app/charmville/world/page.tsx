import {notFound} from 'next/navigation';
import {charmvilleAdmissionMode} from '@/lib/charmville/admission';
import {charmvilleRuntimePrefix} from '@/lib/charmville/runtime-config';
import NativePlankSpaceWalletBridge from "@/components/plankspace/NativePlankSpaceWalletBridge";
import World from "./world";

export const dynamic = "force-dynamic";
export const metadata = { title: "Charmville · Shared world" };

export default function WorldPage() {
  if(charmvilleAdmissionMode()==='disabled')notFound();
  return <><NativePlankSpaceWalletBridge /><World localRuntime={process.env.NODE_ENV === "development"} runtimePrefix={charmvilleRuntimePrefix()} /></>;
}

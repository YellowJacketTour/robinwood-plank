import NativePlankSpaceWalletBridge from "@/components/plankspace/NativePlankSpaceWalletBridge";
import World from "./world";

export const metadata = { title: "Charmville · Shared world" };

export default function WorldPage() {
  return <><NativePlankSpaceWalletBridge /><World localRuntime={process.env.NODE_ENV === "development"} /></>;
}

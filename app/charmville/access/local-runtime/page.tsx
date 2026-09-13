import { notFound } from "next/navigation";
import { localRuntimeFixtureEnabled } from "@/app/api/charmville/local-runtime-fixture/policy";
import LocalRuntime from "./local-runtime";
export const dynamic = "force-dynamic";
export const metadata = { title: "Isolated Charmville playtest", robots: { index: false, follow: false }, referrer: "no-referrer" as const };
export default function LocalRuntimePage() {
  if (!localRuntimeFixtureEnabled(process.env)) notFound();
  return <LocalRuntime />;
}

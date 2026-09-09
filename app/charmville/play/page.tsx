import { notFound } from "next/navigation";
import { headers } from "next/headers";
import Nav from "@/components/Nav";
import AppBackdrop from "@/components/AppBackdrop";
import { localPlaytestEnabled } from "@/lib/charmville/local-playtest-policy";
import LocalPlaytest from "./playtest";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your Charmville board", robots: { index: false, follow: false } };

export default async function LocalPlaytestPage() {
  if (!localPlaytestEnabled(process.env)) notFound();
  const host = (await headers()).get("host") || "";
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) notFound();
  return <><Nav /><AppBackdrop /><LocalPlaytest /></>;
}

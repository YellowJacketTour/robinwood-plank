import { notFound, redirect } from "next/navigation";
import { currentPlaytestIdentity, playtestEnabled } from "@/lib/playtest-auth";

export const dynamic = "force-dynamic";

export default async function PlaytestGamePage({ searchParams }: { searchParams: Promise<{ room?: string }> }) {
  if (!playtestEnabled()) notFound();
  const [identity, query] = await Promise.all([currentPlaytestIdentity(), searchParams]);
  if (!identity) redirect("/playtest");
  const room = typeof query.room === "string" && /^[0-9a-f-]{36}$/i.test(query.room) ? query.room : "";
  return <main id="main-content" className="fixed inset-0 bg-black">
    <iframe
      src={`/arcade/crash.html?playtest=1${room ? `&room=${encodeURIComponent(room)}` : ""}`}
      title="PlankCrash private multiplayer table"
      className="h-full w-full border-0"
      allow="clipboard-write"
    />
  </main>;
}

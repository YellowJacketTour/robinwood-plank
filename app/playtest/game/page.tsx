import { notFound, redirect } from "next/navigation";
import { currentPlaytestIdentity, playtestEnabled } from "@/lib/playtest-auth";
import { readFile } from "node:fs/promises";
import path from "node:path";

// The invite table (the green board) is the game. Its gate is a token the
// gateway keeps on this same host, in the state directory the supervisor
// owns; the Next app runs as the same user, so an authenticated host or
// invited player can be sent straight to it. Nothing is exposed to anyone who
// has not already passed the passkey/PIN gate above.
async function inviteTableUrl(): Promise<string | null> {
  const file = process.env.PLANK_INVITE_TOKEN_FILE?.trim() || path.resolve(process.cwd(), "../shared/plankcrash/state/invite-token.txt");
  try {
    const token = (await readFile(file, "utf8")).trim();
    return /^[A-Za-z0-9_-]{20,}$/.test(token) ? `/table#invite=${token}` : null;
  } catch {
    return null;
  }
}

export const dynamic = "force-dynamic";

export default async function PlaytestGamePage({ searchParams }: { searchParams: Promise<{ room?: string }> }) {
  if (!playtestEnabled()) notFound();
  const [identity, query] = await Promise.all([currentPlaytestIdentity(), searchParams]);
  if (!identity) redirect("/playtest");
  // Host credentials open the invite table, not the credits/rooms playtest:
  // that surface is an earlier build and reads as the wrong game.
  const table = await inviteTableUrl();
  if (table) redirect(table);
  if (typeof query.room !== "string") {
    return <main id="main-content" className="fixed inset-0 grid place-items-center bg-black p-6 text-center text-cream-muted">
      <div className="max-w-md space-y-3">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-gold-400">PlankCrash</p>
        <h1 className="text-3xl text-gold-300">The table is restarting</h1>
        <p className="text-sm leading-6">It rebuilds itself within a minute. <a className="underline" href="/playtest/game">Try again</a> or go back to <a className="underline" href="/playtest">the lobby</a>.</p>
      </div>
    </main>;
  }
  const room = typeof query.room === "string" && /^[0-9a-f-]{36}$/i.test(query.room) ? query.room : "";
  // viewportFit "cover" (app/layout.tsx) extends this fixed shell under the
  // iPhone status bar / home indicator, and env() safe-area values do NOT
  // reliably propagate into the iframe document — so the shell itself keeps
  // the game out of the unsafe strips. env() is 0 everywhere else.
  return <main id="main-content" className="fixed inset-0 bg-black"
    style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
    <iframe
      src={`/arcade/crash.html?playtest=1${room ? `&room=${encodeURIComponent(room)}` : ""}`}
      title="PlankCrash private multiplayer table"
      className="h-full w-full border-0"
      allow="clipboard-write"
    />
  </main>;
}

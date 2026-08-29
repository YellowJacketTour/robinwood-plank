"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LIVE_GROWTH_PER_SECOND } from "@/lib/playtest-live-shared";
import PlankCrashScene from "@/components/playtest/PlankCrashScene";
import { connectionState, presentedMultiplierBps, signedNet, type VisibleCommand } from "@/lib/playtest-presentation";

type Identity = { id: string; displayName: string; isAdmin: boolean };
type RoomItem = { id: string; joinCode: string; name: string; phase: string; owner: boolean; members: number };
type Snapshot = {
  serverNow: string;
  room: { id: string; joinCode: string; name: string; isOwner: boolean; isAdmin: boolean; rulesHash: string; phase: "lobby" | "running" | "settled"; version: string; currentRound: string; commitment: string | null; reveal: string | null; crashBps: string | null; startedAt: string | null; crashAt: string | null };
  policy: Record<string, string | number>;
  simulation: { iteration: string; protectedPrincipal: string; emissionBuffer: string; lottery: { netPrize: string; highWaterPrize: string; pendingFunding: string; resetReserve: string }; totals: Record<string, string> };
  members: Array<{ id: string; displayName: string; balance: string }>;
  seats: Array<{ userId: string; displayName: string; stake: string; requestedTargetBps: string; acceptedTargetBps: string | null; payout: string | null; survived: boolean | null }>;
  events: Array<{ sequence: string; type: string; commandId: string | null; at: string }>;
};

const credits = (value?: string | null) => value ? BigInt(value).toLocaleString() : "0";
const multi = (value?: string | null) => value ? `${(Number(value) / 10_000).toFixed(2)}×` : "—";
const uuid = () => crypto.randomUUID();

async function json<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(data.message || "Request failed.");
  return data;
}

export function GameLaboratory({ identity }: { identity: Identity }) {
  const [rooms, setRooms] = useState<RoomItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [name, setName] = useState(`${identity.displayName}'s table`);
  const [code, setCode] = useState("");
  const [stake, setStake] = useState("10000");
  const [target, setTarget] = useState("2.00");
  const [policyKey, setPolicyKey] = useState("minimumPlayers");
  const [policyValue, setPolicyValue] = useState("2");
  const [creditUser, setCreditUser] = useState("");
  const [creditBalance, setCreditBalance] = useState("1000000");
  const [notice, setNotice] = useState("Ready.");
  const [inviteUrl, setInviteUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [transport, setTransport] = useState<"idle" | "live" | "reconnecting">("idle");
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [receipt, setReceipt] = useState<VisibleCommand | null>(null);
  const [now, setNow] = useState(0);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const generation = useRef(0);

  const loadRooms = useCallback(async () => {
    const result = await json<{ rooms: RoomItem[] }>(await fetch("/api/playtest/rooms", { cache: "no-store" }));
    setRooms(result.rooms); setSelected((old) => old ?? result.rooms[0]?.id ?? null);
  }, []);
  const loadRoom = useCallback(async (id: string, quiet = false) => {
    const current = ++generation.current;
    try {
      const result = await json<Snapshot>(await fetch(`/api/playtest/rooms/${id}`, { cache: "no-store" }));
      if (current === generation.current) { setClockOffsetMs(Date.parse(result.serverNow) - Date.now()); setSnap(result); }
    } catch (error) { if (!quiet) setNotice(error instanceof Error ? error.message : "Room unavailable."); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadRooms().catch((error) => setNotice(String(error))); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadRooms]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const run = async () => {
      let after = "-1";
      while (!controller.signal.aborted) {
        try {
          const result = await json<{ unchanged: boolean; version: string; serverNow?: string; snapshot?: Snapshot }>(await fetch(`/api/playtest/rooms/${selected}/updates?after=${encodeURIComponent(after)}`, { cache: "no-store", signal: controller.signal }));
          if (result.snapshot) { setClockOffsetMs(Date.parse(result.snapshot.serverNow) - Date.now()); setSnap(result.snapshot); after = result.snapshot.room.version; }
          else { if (result.serverNow) setClockOffsetMs(Date.parse(result.serverNow) - Date.now()); after = result.version; }
          setLastSuccessAt(Date.now()); setTransport("live");
        } catch {
          if (controller.signal.aborted) break;
          setTransport("reconnecting");
          await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        }
      }
    };
    void run();
    return () => controller.abort();
  }, [selected]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), snap?.room.phase === "running" ? 100 : 1_000);
    return () => window.clearInterval(timer);
  }, [snap?.room.phase]);

  const roomAction = async (action: "create" | "join") => {
    setBusy(action); setNotice(`${action === "create" ? "Creating" : "Joining"} room…`);
    try {
      const result = await json<{ id: string }>(await fetch("/api/playtest/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action === "create" ? { action, name } : { action, code }) }));
      await loadRooms(); setSelected(result.id); setNotice("Room ready.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Room command failed."); } finally { setBusy(null); }
  };
  const command = async (action: "bet" | "start" | "lock" | "settle" | "tick" | "adminPolicy" | "adminCredit", extra: Record<string, unknown> = {}) => {
    if (!selected) return;
    const id = uuid();
    setReceipt({ id, action, status: "submitting", message: `${action} submitted to the authoritative room.` });
    setBusy(action); setNotice(action === "lock" ? "Sending lock…" : `${action} pending…`);
    try {
      await json(await fetch(`/api/playtest/rooms/${selected}/commands`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, commandId: id, ...extra }) }));
      await loadRoom(selected);
      setReceipt({ id, action, status: "accepted", message: action === "lock" ? "Lock accepted by the authoritative server." : `${action} accepted.` });
      setNotice(action === "lock" ? "Lock accepted by the authoritative server." : `${action} accepted.`);
    } catch (error) {
      try {
        const reconciliation = await json<{ receipt: { commandId: string; sequence?: string } | null }>(await fetch(`/api/playtest/rooms/${selected}/events?commandId=${encodeURIComponent(id)}`, { cache: "no-store" }));
        if (reconciliation.receipt?.commandId === id) {
          await loadRoom(selected);
          setReceipt({ id, action, status: "accepted", sequence: reconciliation.receipt.sequence, message: `${action} confirmed from the authoritative receipt after response loss.` });
          setNotice(`${action} confirmed from the authoritative receipt after response loss.`); return;
        }
      } catch { /* Preserve the original command failure below. */ }
      const message = error instanceof Error ? `${error.message} Command ${id} was not found in the current replay window.` : `Command ${id} failed.`;
      setReceipt({ id, action, status: "unknown", message });
      setNotice(message);
    } finally { setBusy(null); }
  };
  const verifyProof = async () => {
    if (!snap?.room.reveal || !snap.room.commitment) { setNotice("Reveal becomes available after settlement."); return; }
    const bytes = Uint8Array.from(snap.room.reveal.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((part) => part.toString(16).padStart(2, "0")).join("");
    setNotice(digest === snap.room.commitment ? "Commitment verified locally: the reveal matches. This check alone does not verify the outcome formula." : "COMMITMENT FAILURE: reveal does not match commitment.");
  };
  const recheckReceipt = async () => {
    if (!selected || !receipt) return;
    setBusy("receipt");
    try {
      const result = await json<{ receipt: { commandId: string; sequence?: string } | null }>(await fetch(`/api/playtest/rooms/${selected}/events?commandId=${encodeURIComponent(receipt.id)}`, { cache: "no-store" }));
      if (result.receipt?.commandId === receipt.id) {
        setReceipt({ ...receipt, status: "accepted", sequence: result.receipt.sequence, message: `${receipt.action} is present in the authoritative replay.` });
        await loadRoom(selected);
      } else {
        setReceipt({ ...receipt, status: "unknown", message: "No authoritative receipt yet. The original command identifier is preserved; do not submit a duplicate." });
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Receipt reconciliation failed.");
    } finally { setBusy(null); }
  };
  const exportSnapshot = async () => {
    if (!snap) return;
    try {
      const replay = await json(await fetch(`/api/playtest/rooms/${snap.room.id}/events?after=0&limit=1000`, { cache: "no-store" }));
      const url = URL.createObjectURL(new Blob([JSON.stringify({ snapshot: snap, replay }, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `plank-room-${snap.room.id}-round-${snap.room.currentRound}.json`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice("Replay JSON exported.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Replay export failed."); }
  };
  const createInvite = async () => {
    if (!selected) return;
    setBusy("invite"); setNotice("Creating a one-use invitation…");
    try {
      const result = await json<{ url: string }>(await fetch("/api/playtest/invites", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId: selected }),
      }));
      setInviteUrl(result.url);
      await navigator.clipboard?.writeText(result.url).catch(() => {});
      setNotice("Invitation created and copied. It expires in seven days and works once.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Invitation failed."); }
    finally { setBusy(null); }
  };

  const liveBps = useMemo(() => {
    if (!snap?.room.startedAt || snap.room.phase !== "running") return null;
    return Math.floor(10_000 * Math.exp(LIVE_GROWTH_PER_SECOND * Math.max(0, now + clockOffsetMs - Date.parse(snap.room.startedAt)) / 1_000));
  }, [snap?.room.startedAt, snap?.room.phase, now, clockOffsetMs]);
  const deadlinePassed = Boolean(snap?.room.crashAt && now + clockOffsetMs >= Date.parse(snap.room.crashAt));
  const shownBps = snap ? presentedMultiplierBps({ phase: snap.room.phase, liveBps, crashBps: snap.room.crashBps, deadlinePassed }) : 10_000;
  const freshness = transport === "reconnecting" ? "offline" : connectionState(lastSuccessAt, now);
  const me = snap?.members.find((item) => item.id === identity.id);
  const seat = snap?.seats.find((item) => item.userId === identity.id);

  return <div data-market-shell className="site-shell min-h-screen px-1 py-2 text-cream md:px-3">
    <div className="mx-auto max-w-[1500px]">
      <header className="rounded-xl border border-line bg-panel px-4 py-3 shadow-xl">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-[.18em] text-gold-400">Simulation · no value · test credits</p><h1 className="mt-1 font-display text-2xl text-gold-300">PlankCrash Private Table</h1></div><div className="flex flex-wrap gap-2 text-xs"><span className={`rounded-full border px-3 py-2 ${freshness === "live" ? "border-emerald-400/40 text-emerald-200" : freshness === "delayed" ? "border-gold-500 text-gold-300" : "border-line text-cream-muted"}`}>● {freshness === "live" ? "Authoritative live" : freshness === "delayed" ? "Updates delayed" : transport === "reconnecting" ? "Reconnecting" : "No live room"}</span><span className="rounded-full border border-line px-3 py-2">Clock {clockOffsetMs >= 0 ? "+" : ""}{clockOffsetMs} ms</span><span className="rounded-full border border-line px-3 py-2">{identity.displayName}</span></div></div>
      </header>
      <p role="status" aria-live="polite" className="my-3 min-h-10 rounded-lg bg-white/5 px-3 py-2 text-sm text-cream-muted">{notice}</p>

      {!selected ? <section className="grid gap-4 md:grid-cols-2">
        <Panel title="Create a private PlankCrash table"><label className="text-sm">Table name<input value={name} maxLength={48} onChange={(e) => setName(e.target.value)} className="mt-2 min-h-12 w-full rounded-md border border-line bg-panel-strong px-3" /></label><button disabled={Boolean(busy)} onClick={() => roomAction("create")} className="mt-4 min-h-12 w-full rounded-md bg-gold-500 font-black text-wood-950">Create table</button></Panel>
        <Panel title="Join friends"><label className="text-sm">Table code<input value={code} maxLength={8} onChange={(e) => setCode(e.target.value.toUpperCase())} className="mt-2 min-h-12 w-full rounded-md border border-line bg-panel-strong px-3 font-mono tracking-[.2em]" /></label><button disabled={Boolean(busy)} onClick={() => roomAction("join")} className="mt-4 min-h-12 w-full rounded-md border border-gold-500 font-black text-gold-300">Join table</button></Panel>
      </section> : snap ? <>
        <nav aria-label="Rooms" className="mb-3 flex gap-2 overflow-auto">{rooms.map((room) => <button key={room.id} onClick={() => { if (room.id !== selected) setSnap(null); setSelected(room.id); }} className={`min-h-11 shrink-0 rounded-md border px-3 text-sm ${room.id === selected ? "border-gold-400 bg-gold-500/15" : "border-line"}`}>{room.name} · {room.members}</button>)}<button onClick={() => { setSnap(null); setSelected(null); setTransport("idle"); setLastSuccessAt(null); }} className="min-h-11 shrink-0 rounded-md border border-line px-3">＋ Room</button></nav>
        <section className="grid gap-3 xl:grid-cols-[1.5fr_.7fr]">
          <div className="overflow-hidden rounded-2xl border border-line bg-panel-strong shadow-2xl">
            <div className="flex flex-wrap justify-between border-b border-line px-4 py-3 text-xs"><span>Room <b className="font-mono text-gold-300">{snap.room.joinCode}</b></span><span>Round #{snap.room.currentRound} · v{snap.room.version}</span><span>{snap.room.phase.toUpperCase()}</span></div>
            <div className="relative">
              <PlankCrashScene phase={snap.room.phase} liveMultiplier={shownBps / 10_000} crashMultiplier={snap.room.crashBps ? Number(snap.room.crashBps) / 10_000 : null} deadlinePassed={deadlinePassed} />
              <div className="absolute inset-x-0 bottom-0 z-20 px-3 pb-4 sm:px-6 sm:pb-6">
                {snap.room.commitment && <p className="mx-auto mb-3 max-w-xl truncate rounded bg-panel-strong px-3 py-2 text-center font-mono text-[10px] text-cream-muted">commit {snap.room.commitment}</p>}
                <button onClick={() => command("lock")} disabled={Boolean(busy) || snap.room.phase !== "running" || deadlinePassed || Boolean(seat?.acceptedTargetBps) || (receipt?.action === "lock" && receipt.status === "unknown")} className="mx-auto block min-h-20 w-full max-w-xl rounded-xl border-2 border-gold-300 bg-gold-500 px-5 text-2xl font-black uppercase text-wood-950 shadow-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold-300 disabled:opacity-40">{seat?.acceptedTargetBps ? `Locked ${multi(seat.acceptedTargetBps)}` : deadlinePassed ? "Awaiting settlement" : busy === "lock" ? "Sending…" : receipt?.action === "lock" && receipt.status === "unknown" ? "Lock status unknown" : "Lock now"}</button>
              </div>
            </div>
          </div>
          <aside className="grid content-start gap-3"><Panel title="Your flight plan"><p className="text-sm text-cream-muted">Balance: {credits(me?.balance)}</p><div className="mt-3 grid grid-cols-2 gap-2"><label className="text-xs">Stake<input inputMode="numeric" value={stake} onChange={(e) => setStake(e.target.value.replace(/\D/g, ""))} className="mt-1 min-h-12 w-full rounded border border-line bg-panel-strong px-2" /></label><label className="text-xs">Auto-lock ×<input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} className="mt-1 min-h-12 w-full rounded border border-line bg-panel-strong px-2" /></label></div><button onClick={() => command("bet", { stake, targetBps: String(Math.round(Number(target) * 10_000)) })} disabled={Boolean(busy) || snap.room.phase === "running"} className="mt-3 min-h-12 w-full rounded bg-gold-500 font-black text-wood-950 disabled:opacity-40">Commit test credits</button>{seat && <p className="mt-3 text-xs">Stake {credits(seat.stake)} · target {multi(seat.requestedTargetBps)} · lock {multi(seat.acceptedTargetBps)}</p>}{snap.room.phase === "running" && deadlinePassed && <button onClick={() => command("tick")} disabled={Boolean(busy)} className="mt-3 min-h-12 w-full rounded border border-gold-400 text-gold-300 disabled:opacity-40">Settle as keeper</button>}</Panel>{snap.room.isOwner && <Panel title="Host controls"><button onClick={() => command("start")} disabled={Boolean(busy) || snap.room.phase === "running"} className="min-h-12 w-full rounded border border-emerald-400 text-emerald-200 disabled:opacity-40">Launch round</button><div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">{(["none", "miss", "hit"] as const).map((outcome) => <button key={outcome} onClick={() => command("settle", { lotteryOutcome: outcome })} disabled={Boolean(busy) || snap.room.phase !== "running" || !deadlinePassed} className="min-h-11 rounded border border-line text-xs uppercase disabled:opacity-40">{outcome}</button>)}</div></Panel>}</aside>
        </section>
        {identity.isAdmin && <section className="mt-3"><Panel title="Admin simulation console">
          <p className="mb-4 text-xs text-cream-muted">Host-PIN controls are server-validated, room-scoped, and written to the authoritative replay log. Parameters can change only between rounds.</p>
          <div className="mb-4 rounded-lg border border-line bg-panel-soft p-3"><p className="text-xs font-black uppercase tracking-wider text-gold-300">Invite a player to this room</p><button onClick={createInvite} disabled={Boolean(busy) || !selected} className="mt-2 min-h-11 rounded border border-gold-400 px-4 text-gold-300 disabled:opacity-40">Create and copy one-use link</button>{inviteUrl ? <input aria-label="Latest invitation URL" readOnly value={inviteUrl} onFocus={(event) => event.currentTarget.select()} className="mt-2 min-h-11 w-full rounded border border-line bg-panel-strong px-2 font-mono text-xs" /> : null}</div>
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
            <label className="text-xs">Economic parameter<select value={policyKey} onChange={(e) => { setPolicyKey(e.target.value); setPolicyValue(String(snap.policy[e.target.value] ?? "0")); }} className="mt-1 min-h-11 w-full rounded border border-line bg-panel-strong px-2">
              {["minimumPlayers","minimumStake","protectedPrincipalBps","keeperRewardBps","crashSeed","emissionBufferCap","lotteryFounderFeeBps","lotteryInitialBase","lotteryMinimumIncrease","lotteryBaseGrowthBps","lotteryMinimumBaseStep","consolation"].map((key) => <option key={key}>{key}</option>)}
            </select></label>
            <label className="text-xs">Value<input inputMode="numeric" value={policyValue} onChange={(e) => setPolicyValue(e.target.value.replace(/\D/g, ""))} className="mt-1 min-h-11 w-full rounded border border-line bg-panel-strong px-2 font-mono" /></label>
            <button onClick={() => command("adminPolicy", { policy: { [policyKey]: policyValue } })} disabled={Boolean(busy) || snap.room.phase === "running" || !policyValue} className="min-h-11 self-end rounded border border-gold-500 px-4 text-gold-300 disabled:opacity-40">Apply parameter</button>
          </div>
          <div className="my-4 h-px bg-line" />
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
            <label className="text-xs">Player<select value={creditUser} onChange={(e) => setCreditUser(e.target.value)} className="mt-1 min-h-11 w-full rounded border border-line bg-panel-strong px-2"><option value="">Choose player</option>{snap.members.map((member) => <option value={member.id} key={member.id}>{member.displayName}</option>)}</select></label>
            <label className="text-xs">Test-credit balance<input inputMode="numeric" value={creditBalance} onChange={(e) => setCreditBalance(e.target.value.replace(/\D/g, ""))} className="mt-1 min-h-11 w-full rounded border border-line bg-panel-strong px-2 font-mono" /></label>
            <button onClick={() => command("adminCredit", { userId: creditUser, balance: creditBalance })} disabled={Boolean(busy) || !creditUser || !creditBalance} className="min-h-11 self-end rounded border border-line-strong px-4 text-gold-300 disabled:opacity-40">Set balance</button>
          </div>
        </Panel></section>}
        <section className="mt-3 grid gap-3 lg:grid-cols-3"><Metrics title="Heartwood Vault" rows={[["Protected principal", credits(snap.simulation.protectedPrincipal)], ["Emission buffer", credits(snap.simulation.emissionBuffer)], ["Iterations", snap.simulation.iteration]]} /><Metrics title="Powerboard" rows={[["Current prize", credits(snap.simulation.lottery.netPrize)], ["High water", credits(snap.simulation.lottery.highWaterPrize)], ["Reset reserve", credits(snap.simulation.lottery.resetReserve)]]} /><Metrics title="Rake flow" rows={[["Gross rake", credits(snap.simulation.totals.grossRake)], ["Burn", credits(snap.simulation.totals.burned)], ["Community", credits(snap.simulation.totals.communityFunded)], ["Founders", credits(snap.simulation.totals.crashFounderRake)]]} /></section>
        {receipt && <section aria-label="Latest authoritative command" className="mt-3 rounded-xl border border-line bg-panel-strong p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-display text-lg text-gold-300">Latest command receipt</h2><span className="rounded-full border border-line px-3 py-1 font-mono text-xs uppercase">{receipt.status}</span></div><p className="mt-2 text-sm text-cream-muted">{receipt.message}</p><p className="mt-2 break-all font-mono text-[11px] text-cream-muted">{receipt.action} · {receipt.id}{receipt.sequence ? ` · event #${receipt.sequence}` : ""}</p>{receipt.status === "unknown" ? <button onClick={recheckReceipt} disabled={Boolean(busy)} className="mt-3 min-h-11 rounded border border-gold-400 px-4 text-gold-300 disabled:opacity-40">Recheck original receipt</button> : null}</section>}
        <section className="mt-3 grid gap-3 xl:grid-cols-2"><Panel title="Pilots and receipts"><div className="overflow-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead><tr className="text-cream-muted"><th>Pilot</th><th>Stake</th><th>Target</th><th>Lock</th><th>Result</th><th>Payout</th><th>Net</th></tr></thead><tbody>{snap.seats.map((s) => { const net = signedNet(s.stake, s.payout); return <tr key={s.userId} className="border-t border-line"><td className="py-3">{s.displayName}</td><td>{credits(s.stake)}</td><td>{multi(s.requestedTargetBps)}</td><td>{multi(s.acceptedTargetBps)}</td><td>{s.survived === null ? "Pending" : s.survived ? "Survived" : "Busted"}</td><td>{s.payout ? credits(s.payout) : "—"}</td><td className={net === null ? "text-cream-muted" : net > 0n ? "text-emerald-300" : net < 0n ? "text-rose-300" : "text-cream"}>{net === null ? "—" : `${net > 0n ? "+" : ""}${net.toLocaleString()}`}</td></tr>; })}</tbody></table></div></Panel><Panel title="Authoritative event log"><ol className="max-h-64 space-y-2 overflow-auto font-mono text-xs">{snap.events.slice().reverse().map((item) => <li key={item.sequence} className="rounded bg-panel-soft p-2"><b className="text-gold-300">#{item.sequence}</b> {item.type}{item.commandId ? <span className="block truncate text-cream-muted">{item.commandId}</span> : null}<time className="float-right text-cream-muted">{new Date(item.at).toLocaleTimeString()}</time></li>)}</ol><details className="mt-3 text-xs"><summary className="min-h-11 cursor-pointer py-3 font-bold">Proof identifiers</summary><p className="break-all font-mono">rules {snap.room.rulesHash}<br />commit {snap.room.commitment ?? "—"}<br />reveal {snap.room.reveal ?? "hidden until settlement"}</p><div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2"><button onClick={verifyProof} className="min-h-11 rounded border border-emerald-400 text-emerald-200">Check commitment</button><button onClick={exportSnapshot} className="min-h-11 rounded border border-line">Export JSON</button></div></details></Panel></section>
      </> : <p className="p-10 text-center">Loading authoritative snapshot…</p>}
    </div>
  </div>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) { return <section className="data-module min-w-0 rounded-xl border border-line p-4"><h2 className="mb-3 font-display text-lg text-gold-300">{title}</h2>{children}</section>; }
function Metrics({ title, rows }: { title: string; rows: Array<[string, string]> }) { return <Panel title={title}><dl className="space-y-2 text-sm">{rows.map(([label, value]) => <div key={label} className="flex justify-between border-t border-line pt-2"><dt className="text-cream-muted">{label}</dt><dd className="font-mono tabular-nums">{value}</dd></div>)}</dl></Panel>; }

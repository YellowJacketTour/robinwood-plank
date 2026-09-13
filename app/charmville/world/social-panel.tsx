"use client";

import { useEffect, useRef, useState } from "react";
import SocialCharmBasket, { type BasketPin, type BasketPinResult, type BasketPost } from "./social-charm-basket";
import styles from "./social-charm-basket.module.css";

type SocialData = {
  posts: { id: string; body: string; authorHandle: string; authorName: string | null; createdAt: string; oranPins: string }[];
  basket: { face: string; qty: string }[];
};
type Props = { token: string; active: boolean; onPinned?: () => void };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
function socialData(value: unknown): value is SocialData {
  return record(value) && Array.isArray(value.posts) && value.posts.length <= 30 && value.posts.every(post =>
    record(post) && typeof post.id === "string" && /^[1-9]\d{0,17}$/.test(post.id) && typeof post.body === "string" &&
    typeof post.authorHandle === "string" && (post.authorName === null || typeof post.authorName === "string") &&
    typeof post.createdAt === "string" && count(post.oranPins)) && Array.isArray(value.basket) && value.basket.every(item =>
      record(item) && item.face === "oran-berry" && count(item.qty));
}

/** Identity changes discard the former account's private basket immediately. */
export default function SocialPanel(props: Props) {
  return <SocialAccountPanel key={props.token} {...props} />;
}

function SocialAccountPanel({ token, active, onPinned }: Props) {
  const [data, setData] = useState<SocialData | null>(null);
  const [target, setTarget] = useState<BasketPost | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const loaded = useRef(false);

  async function refresh() {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const version = ++epoch.current;
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/charmville/social", {
        headers: { authorization: `Bearer ${token}` }, cache: "no-store", mode: "same-origin", redirect: "error", signal: abort.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The feed could not be loaded.");
      if (!socialData(result)) throw new Error("The feed response was incomplete. Please refresh.");
      if (version === epoch.current) { setData(result); loaded.current = true; }
    } catch (cause) {
      if (!abort.signal.aborted && version === epoch.current) setError(cause instanceof Error ? cause.message : "The feed is unavailable.");
    } finally { if (version === epoch.current) setLoading(false); }
  }

  useEffect(() => {
    if (active && !loaded.current && token) void refresh();
    // Opening fetches once; later refresh is explicit so reading targets never jump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, token]);
  useEffect(() => () => { ++epoch.current; controller.current?.abort(); }, []);

  async function pin(command: BasketPin): Promise<BasketPinResult> {
    // A feed read begun before this spend cannot restore its old balance afterward.
    controller.current?.abort(); ++epoch.current; setLoading(false);
    const response = await fetch("/api/charmville/social", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ postId: command.postId, face: command.face, requestId: command.requestId }),
      mode: "same-origin", redirect: "error",
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || "The pin could not be confirmed."), {
      definitive: [400, 401, 403, 404, 409, 413, 422].includes(response.status),
    });
    if (!record(result) || typeof result.receiptId !== "string" || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(result.receiptId) ||
      result.postId !== command.postId || result.face !== command.face || result.qty !== 1 || !count(result.remaining))
      throw new Error("The pin receipt was incomplete. Retry to check this same pin.");
    setData(previous => previous ? { ...previous, basket: previous.basket.map(item => item.face === command.face ? { ...item, qty: String(result.remaining) } : item) } : previous);
    return { remainingQuantity: Number(result.remaining) };
  }

  const oranQuantity = Number(data?.basket.find(item => item.face === "oran-berry")?.qty ?? 0);
  return <div hidden={!active} onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
    {target ? <SocialCharmBasket key={target.id} post={target}
      charms={[{ id: "oran-berry", name: "Oran Berry", image: "/charmville/items/oran-berry.png", quantity: Number.isSafeInteger(oranQuantity) ? oranQuantity : 0, description: "Grown at home. Useful on your journey, or a little gift pinned to a post." }]}
      onPin={pin} onClose={() => { setTarget(null); void refresh(); }} onPinned={() => onPinned?.()} />
      : <section className={styles.basket} aria-label="PlankSpace public posts" aria-busy={loading}>
        <header className={styles.header}><div><span className={styles.eyebrow}>Charmdex · PlankSpace</span><h2>Public posts</h2></div>
          <button type="button" disabled={loading || !token} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh"}</button></header>
        <p className={styles.hint}>A little of your adventure, shared. Pin an owned Oran Berry without leaving the game.</p>
        {error && <p role="alert">{error}</p>}
        {!token && <p>Sign in to open your account’s charm basket.</p>}
        {data?.posts.length === 0 && <p className={styles.empty}>No public posts are available yet.</p>}
        <div className={styles.feed}>{data?.posts.map(post => <article key={post.id} className={styles.post}>
          <strong>{post.authorName || post.authorHandle}</strong><span className={styles.byline}> @{post.authorHandle}</span>
          <p>{post.body}</p><div className={styles.postActions}><span>{post.oranPins} Oran pins</span>
            <button type="button" onClick={() => setTarget({ id: post.id, author: post.authorHandle, excerpt: post.body })}>Open charm basket</button>
          </div></article>)}</div>
      </section>}
  </div>;
}

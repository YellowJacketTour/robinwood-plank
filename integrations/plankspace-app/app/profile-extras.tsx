"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { connectPlankLoveWallet, getPlankLoveWalletState, subscribePlankLoveWalletState } from "./plank-love-wallet";
import { walletProof } from "./auth-client";
import ContentActions from "./content-actions";
import { MediaAttachment, MediaComposer } from "./post-media-ui";
import type { PostMedia } from "./post-media";
import { walletStateConfirmsDisconnect } from "./x-share-state";
type Post = {
  id: number;
  author: string;
  body: string;
  likes: number;
  createdAt: string;
  mediaUrl?: string;
  mediaType?: string;
  mediaAlt?: string;
  source?: string;
  xPublishStatus?: string;
  xPostUrl?: string;
};
type Plank = { id: string; name: string; image: string | null };
export function MiniGame() {
  const [on, setOn] = useState(false),
    [score, setScore] = useState(0),
    [time, setTime] = useState(20),
    [pos, setPos] = useState({ x: 45, y: 42 }),
    [message, setMessage] = useState("");
  useEffect(() => {
    if (!on) return;
    const t = setInterval(
      () =>
        setTime((v) => {
          if (v <= 1) {
            setOn(false);
            return 0;
          }
          return v - 1;
        }),
      1000
    );
    return () => clearInterval(t);
  }, [on]);
  const start = () => {
      setScore(0);
      setTime(20);
      setMessage("");
      setOn(true);
    },
    save = async () => {
      try {
        const wallet = await connectPlankLoveWallet(),
          data = { score },
          proof = await walletProof(wallet, "score:save", "plank-attack", data),
          r = await fetch("/api/scores", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...proof, ...data }),
          }).then((x) => x.json());
        setMessage(r.error || "Score saved to the leaderboard!");
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "Score save failed");
      }
    };
  return (
    <div className="game-board" aria-label="Catch Plank mini game">
      {on && (
        <button
          className="game-plank"
          style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
          onClick={() => {
            setScore((v) => v + 1);
            setPos({ x: 8 + Math.random() * 76, y: 12 + Math.random() * 68 });
          }}
          aria-label="Catch Plank"
        >
          <i />
          <i />
        </button>
      )}
      <div className="game-score">
        Score {score} · {time}s
      </div>
      {!on && (
        <div className="game-over">
          <button onClick={start}>
            {time === 0 ? "Play Again" : "Start Game"}
          </button>
          {time === 0 && score > 0 && (
            <button onClick={save}>Save Score</button>
          )}
          {message && <small>{message}</small>}
        </div>
      )}
    </div>
  );
}
export function Feed() {
  const emptyMedia: PostMedia = { mediaUrl: "", mediaType: "", mediaAlt: "" },
    [items, setItems] = useState<Post[]>([]),
    [body, setBody] = useState(""),
    [media, setMedia] = useState<PostMedia>(emptyMedia),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [xConnected,setXConnected]=useState(false),
    [xUsername,setXUsername]=useState(""),
    [xRetryAfter,setXRetryAfter]=useState(0),
    [alsoPostToX,setAlsoPostToX]=useState(false);
  const xStatusRequest = useRef(0);
  useEffect(() => {
    fetch("/api/posts")
      .then((r) => r.json())
      .then((d) => setItems(d.posts || []))
      .catch(() => setMessage("Feed unavailable"));
  }, []);
  useEffect(()=>{const refresh=(state:Awaited<ReturnType<typeof getPlankLoveWalletState>>)=>{const request=++xStatusRequest.current;if(walletStateConfirmsDisconnect(state)){setXConnected(false);setXUsername("");setXRetryAfter(0);setAlsoPostToX(false);return}if(!state.address)return;fetch(`/api/x/status?wallet=${state.address}`).then(async r=>{if(!r.ok)throw new Error("X status unavailable");return r.json()}).then(x=>{if(request!==xStatusRequest.current)return;const connected=Boolean(x.connected);setXConnected(connected);setXUsername(connected?String(x.username||""):"");setXRetryAfter(connected&&!x.postCooldown?.allowed?Number(x.postCooldown.retryAfterSeconds||0):0);if(!connected)setAlsoPostToX(false)}).catch(()=>{/* Preserve the last confirmed X state during transient wallet/media refreshes. */})};void getPlankLoveWalletState().then(refresh);return subscribePlankLoveWalletState(refresh)},[]);
  const act = async (kind: "post" | "like", id?: number) => {
    setBusy(true);
    setMessage("");
    try {
      const wallet = await connectPlankLoveWallet(),
        data = kind === "post" ? { body: body.trim(), ...media, alsoPostToX:xConnected&&alsoPostToX } : { id },
        proof = await walletProof(
          wallet,
          kind === "post" ? "post:create" : "post:like",
          kind === "post" ? "lumberyard" : String(id),
          data
        ),
        result = await fetch("/api/posts", {
          method: kind === "post" ? "POST" : "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...proof, ...data }),
        }).then((r) => r.json());
      if (result.error) throw new Error(result.error);
      if (kind === "post") {
        setItems((v) => [result.post, ...v]);
        setBody("");
        setMedia(emptyMedia);
        setAlsoPostToX(false);
        if (result.xShare?.status === "cooldown") {
          setXRetryAfter(Number(result.xShare.retryAfterSeconds || 300));
          setMessage(`Posted to PlankSpace. X sharing is available again in about ${Math.ceil(Number(result.xShare.retryAfterSeconds || 300) / 60)} minute(s).`);
        } else if (result.post?.xPublishStatus === "failed") {
          setMessage("Posted to PlankSpace, but X sharing failed. Reconnect X and try again.");
        }
      } else setItems((v) => v.map((p) => (p.id === id ? result.post : p)));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="composer">
        <label htmlFor="lumber-post">Post to the Lumberyard</label>
        <textarea
          id="lumber-post"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={500}
          placeholder="What’s on your grain?"
        />
        <MediaComposer
          value={media}
          onChange={setMedia}
          idPrefix="profile-lumber"
        />
        {xConnected&&<label className={`x-share-choice ${alsoPostToX?"is-selected":""} ${xRetryAfter>0?"is-disabled":""}`}>
          <input type="checkbox" checked={alsoPostToX} disabled={xRetryAfter>0} onChange={e=>setAlsoPostToX(e.target.checked)}/>
          <span className="x-share-switch" aria-hidden="true"><i /></span>
          <span className="x-share-copy">
            <b>Share this post to X</b>
            <small>{xRetryAfter>0?`Available again in about ${Math.ceil(xRetryAfter/60)} minute(s)`:alsoPostToX?`Will also publish${xUsername?` as @${xUsername}`:""}`:"Optional · off by default"}</small>
          </span>
        </label>}
        {xConnected&&alsoPostToX&&<div className="x-share-preview">
          <b>X post footer</b>
          <span>Posted from my PlankSpace on Plank.Love</span>
          <small>Long PlankSpace posts are shortened only on X.</small>
        </div>}
        <button disabled={busy || !body.trim()} onClick={() => act("post")}>
          Connect, Sign & Post
        </button>
      </div>
      {message && <p role="alert">{message}</p>}
      <div
        className="feed profile-feed-scroll"
        tabIndex={0}
        role="region"
        aria-label="Latest Lumberyard posts"
      >
        {items.map((p) => (
          <article className="compact-feed-post" key={p.id}>
            <div className="feed-post-copy">
              <div className="feed-post-byline">
                <b>{p.author}</b>
                <time>{new Date(p.createdAt).toLocaleDateString()}</time>
              </div>
              <p>{p.body}</p>
              {p.source==="x"&&<small>Imported from X</small>}{p.xPublishStatus==="published"&&<small>Shared to X</small>}{p.xPublishStatus==="failed"&&<small>X sharing failed; your PlankSpace post is safe.</small>}
              <MediaAttachment
                mediaUrl={p.mediaUrl}
                mediaType={p.mediaType}
                mediaAlt={p.mediaAlt}
              />
            </div>
            <div className="feed-post-actions">
              <button
                className="feed-like"
                disabled={busy}
                onClick={() => act("like", p.id)}
                aria-label={`Like post by ${p.author}`}
              >
                ♡ {p.likes}
              </button>
              <ContentActions
                type="post"
                id={p.id}
                onDeleted={() =>
                  setItems((v) => v.filter((x) => x.id !== p.id))
                }
              />
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
export function PlankShelf({ handle }: { handle: string }) {
  const [items, setItems] = useState<Plank[]>([]),
    [state, setState] = useState("Loading your wallet’s Planks…"),
    load = () => {
      setState("Loading your wallet’s Planks…");
      fetch(`/api/planks?handle=${handle}`)
        .then(async (r) => ({ ok: r.ok, data: await r.json() }))
        .then(({ ok, data }) => {
          setItems(data.items || []);
          setState(
            ok
              ? data.items?.length
                ? ""
                : "No RobinWoods found in this wallet."
              : data.error || "Collection unavailable."
          );
        })
        .catch(() => setState("Collection unavailable."));
    };
  useEffect(load, [handle]);
  return (
    <>
      {items.length ? (
        <div className="nft-grid">
          {items.map((n) => (
            <article className="nft-card" key={n.id}>
              {n.image ? (
                <img src={n.image} alt={n.name} />
              ) : (
                <div className="nft-fallback">
                  <i />
                  <i />
                </div>
              )}
              <b>{n.name}</b>
              <small>#{n.id}</small>
            </article>
          ))}
        </div>
      ) : (
        <div className="collection-state">
          <span>{state}</span>
          {state.includes("unavailable") && (
            <button onClick={load}>Retry</button>
          )}
        </div>
      )}
    </>
  );
}
export function BoardActions({ handle }: { handle: string }) {
  const [message, setMessage] = useState(""),
    [states, setStates] = useState<Record<string, boolean>>({});
  const set = async (kind: string) => {
    setMessage("");
    try {
      const wallet = await connectPlankLoveWallet(),
        saved = await fetch(`/api/relations?wallet=${wallet}`).then((r) =>
          r.json()
        ),
        loaded = Object.fromEntries(
          (saved.relations || [])
            .filter((x: { targetHandle: string }) => x.targetHandle === handle)
            .map((x: { kind: string }) => [x.kind, true])
        ),
        enabled = !loaded[kind],
        data = { targetHandle: handle, kind, enabled },
        proof = await walletProof(wallet, "relation:set", handle, data),
        r = await fetch("/api/relations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...proof, ...data }),
        }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      setStates({ ...loaded, [kind]: r.enabled });
      setMessage(`${kind} ${r.enabled ? "saved" : "removed"}.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Action failed");
    }
  };
  const friend = async () => {
    setMessage("");
    try {
      const wallet = await connectPlankLoveWallet(),
        data = { action: "request", targetHandle: handle },
        proof = await walletProof(wallet, "friend:request", handle, data),
        r = await fetch("/api/friends", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...proof, ...data }),
        }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      setMessage("Friend request sent.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Friend request failed");
    }
  };
  return (
    <div className="board-actions">
      <button onClick={friend}>🤝 Add Friend</button>
      <button onClick={() => set("top8")} aria-pressed={!!states.top8}>
        ➕ Add to Top 8
      </button>
      <button onClick={() => set("favorite")} aria-pressed={!!states.favorite}>
        ☆ Favorite Board
      </button>
      <button onClick={() => set("block")} aria-pressed={!!states.block}>
        🪓 Block Splinters
      </button>
      <button
        onClick={() =>
          navigator.clipboard
            .writeText(location.href)
            .then(() => setMessage("Profile link copied."))
        }
      >
        ↗ Pass the Plank
      </button>
      <ContentActions type="profile" id={handle} />
      {message && (
        <small role="status" aria-live="polite">
          {message}
        </small>
      )}
    </div>
  );
}

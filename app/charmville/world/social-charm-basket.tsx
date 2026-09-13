"use client";

import { useRef, useState } from "react";
import styles from "./social-charm-basket.module.css";

export type BasketCharm = { id: string; name: string; image: string; quantity: number; description: string };
export type BasketPost = { id: string; author: string; excerpt: string };
export type BasketPin = { requestId: string; postId: string; face: string; quantity: 1 };
export type BasketPinResult = { remainingQuantity: number };

/** Mount inside the fullscreen game shell. Keep mounted until a submitted request resolves.
 * Supply authenticated, server-owned quantities and an idempotent pin operation.
 * The post snapshot deliberately never follows incoming feed updates.
 */
export default function SocialCharmBasket({ post, charms, onPin, onClose, onPinned }: {
  post: BasketPost;
  charms: readonly BasketCharm[];
  onPin: (command: BasketPin) => Promise<BasketPinResult>;
  onClose: () => void;
  onPinned?: (command: BasketPin, result: BasketPinResult) => void;
}) {
  const [target] = useState(() => ({ ...post }));
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<BasketPinResult | null>(null);
  const request = useRef<BasketPin | null>(null);
  const inFlight = useRef(false);
  const chosen = charms.find(charm => charm.id === selected);
  const uncertain = submitted && !receipt;

  async function pin() {
    if (inFlight.current || receipt) return;
    if (!request.current) {
      if (!chosen || chosen.quantity < 1) return;
      request.current = { requestId: crypto.randomUUID(), postId: target.id, face: chosen.id, quantity: 1 };
      setSubmitted(true);
    }
    const command = request.current;
    inFlight.current = true;
    setPending(true);
    setMessage("");
    try {
      const result = await onPin(command);
      setReceipt(result);
      setMessage(`Pinned. ${result.remainingQuantity} left in your basket.`);
      onPinned?.(command, result);
    } catch (error) {
      if (error instanceof Error && "definitive" in error && error.definitive === true) {
        request.current = null;
        setSubmitted(false);
      }
      setMessage(error instanceof Error ? error.message : "The pin could not be confirmed. Retry to check the same pin.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return <section className={styles.basket} aria-label="Pin a charm" aria-busy={pending}
    onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" && !uncertain) onClose(); }}>
    <header className={styles.header}><div><span className={styles.eyebrow}>Charmdex · Social</span><h2>Your charm basket</h2></div>
      <button type="button" onClick={onClose} disabled={uncertain}>Back</button></header>
    <div className={styles.post}><strong>For @{target.author}</strong><p>{target.excerpt}</p></div>
    <p className={styles.hint}>Choose a keepsake for this post. Pinning uses one from your satchel.</p>
    <div className={styles.items} aria-label="Owned charms">
      {charms.filter(charm => charm.quantity > 0).map(charm => <button type="button" key={charm.id}
        className={styles.item} aria-pressed={selected === charm.id} disabled={uncertain || !!receipt}
        onClick={() => { setSelected(charm.id); setMessage(""); }}>
        {/* Native item pixels are intentionally preserved rather than optimized as photos. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={charm.image} width="48" height="48" alt="" />
        <strong>{charm.name}</strong><span>× {charm.quantity}</span>
      </button>)}
    </div>
    {!charms.some(charm => charm.quantity > 0) && <p className={styles.empty}>Your basket is empty. Grow and gather at home, then bring a charm to a friend.</p>}
    {chosen && <div className={styles.detail}><h3>{chosen.name}</h3><p>{chosen.description}</p>
      <p>{receipt ? "A little of your adventure now lives on their post." : `Pin 1 ${chosen.name} to @${target.author}’s post?`}</p>
      {!receipt && <button className={styles.confirm} type="button" disabled={pending || (!uncertain && chosen.quantity < 1)} onClick={() => void pin()}>
        {pending ? "Pinning…" : uncertain ? "Retry this pin" : `Pin 1 ${chosen.name}`}
      </button>}
    </div>}
    <p role="status" aria-live="polite" className={styles.status}>{message}</p>
    {uncertain && !pending && <p className={styles.hint}>The result is not confirmed. Retrying checks this same pin; it does not create another.</p>}
    {receipt && <button className={styles.confirm} type="button" onClick={onClose}>Return to the feed</button>}
  </section>;
}

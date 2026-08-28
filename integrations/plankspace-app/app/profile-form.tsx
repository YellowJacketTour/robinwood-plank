"use client";
/* eslint-disable @next/next/no-img-element, react-hooks/set-state-in-effect */
import { useState } from "react";
import { useEffect } from "react";
import {
  connectPlankLoveWallet,
  subscribePlankLoveWalletState,
} from "./plank-love-wallet";
import { walletProof } from "./auth-client";
import { readApiJson } from "./api-client";
import WidgetManager from "./widgets/widget-manager";
import XConnectionManager from "./x/x-connection-manager";
import { CYBERPUNK_PROFILE_CSS, DEFAULT_PROFILE_CSS_GUIDE } from "./customization/default-profile-css";

type FormState = {
  handle: string;
  displayName: string;
  bio: string;
  hobbies: string;
  interests: string;
  music: string;
  heroes: string;
  lookingToMeet: string;
  avatarUrl: string;
  avatarData?: string;
  mood: string;
  moodText: string;
  featuredVideo: string;
  customHtml: string;
  customCss: string;
};
type ThemeState = {
  template: string;
  pageBackground: string;
  panelBackground: string;
  textColor: string;
  linkColor: string;
  headingColor: string;
  accentColor: string;
  fontFamily: string;
  showTop8: boolean;
};
type ThemeColorKey =
  | "pageBackground"
  | "panelBackground"
  | "textColor"
  | "linkColor"
  | "headingColor"
  | "accentColor";
const blank: FormState = {
  handle: "",
  displayName: "",
  bio: "",
  hobbies: "",
  interests: "",
  music: "",
  heroes: "",
  lookingToMeet: "",
  avatarUrl: "",
  avatarData: "",
  mood: "feeling board",
  moodText: "holding down the lumberyard.",
  featuredVideo: "",
  customHtml: "",
  customCss: "",
};
const defaultTheme: ThemeState = {
  template: "lounge",
  pageBackground: "#24130b",
  panelBackground: "#f2dfbe",
  textColor: "#2b160d",
  linkColor: "#6e2b0e",
  headingColor: "#fff0cf",
  accentColor: "#e4862a",
  fontFamily: "Verdana",
  showTop8: true,
};
const modules = [
  "welcome",
  "status",
  "music",
  "video",
  "game",
  "custom",
  "collection",
  "about",
  "friends",
  "widgets",
  "feed",
  "comments",
];

type DirectoryProfile = { handle: string; displayName: string };
function TopEightEditor({
  wallet,
  bypass,
  visible,
  onVisible,
}: {
  wallet: string;
  bypass: boolean;
  visible: boolean;
  onVisible: (value: boolean) => void;
}) {
  const [items, setItems] = useState<string[]>([]),
    [profiles, setProfiles] = useState<DirectoryProfile[]>([]),
    [selected, setSelected] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => {
    const [relations, directory] = await Promise.all([
      fetch(`/api/relations?wallet=${wallet}`).then((r) => r.json()),
      fetch("/api/profiles").then((r) => r.json()),
    ]);
    setItems(
      (relations.relations || [])
        .filter((x: { kind: string }) => x.kind === "top8")
        .sort((a: { rank: number }, b: { rank: number }) => a.rank - b.rank)
        .map((x: { targetHandle: string }) => x.targetHandle)
    );
    setProfiles(directory.profiles || []);
  };
  useEffect(() => {
    void load();
  }, [wallet]);
  const change = async (targetHandle: string, enabled: boolean) => {
    setBusy(true);
    setMessage("");
    try {
      const data = { targetHandle, kind: "top8", enabled },
        proof = bypass
          ? { wallet }
          : await walletProof(wallet, "relation:set", targetHandle, data),
        result = await fetch("/api/relations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...proof, ...data }),
        }).then((r) => r.json());
      if (result.error) throw new Error(result.error);
      await load();
      setSelected("");
      setMessage(
        enabled
          ? `@${targetHandle} added to your Top 8.`
          : `@${targetHandle} removed.`
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Top 8 update failed");
    } finally {
      setBusy(false);
    }
  };
  const available = profiles.filter(
    (p) => !items.includes(p.handle) && p.handle !== "degenwaffle"
  );
  return (
    <div className="top8-editor">
      <div className="top8-heading">
        <div>
          <h2>Customize your Top 8</h2>
          <p>
            Show or hide the section, remove current boards, and fill any open
            slots.
          </p>
        </div>
        <label className="top8-toggle">
          <input
            type="checkbox"
            checked={visible}
            onChange={(e) => onVisible(e.target.checked)}
          />
          <span>{visible ? "Visible" : "Hidden"}</span>
        </label>
      </div>
      <ol>
        {items.map((handle, index) => (
          <li key={handle}>
            <b>#{index + 1}</b>
            <a href={`/u/${handle}`} target="_blank" rel="noreferrer">
              @{handle}
            </a>
            <button
              type="button"
              disabled={busy}
              onClick={() => change(handle, false)}
            >
              Remove
            </button>
          </li>
        ))}
        {!items.length && <li className="top8-empty">Your Top 8 is empty.</li>}
      </ol>
      <div className="top8-add">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={busy || items.length >= 8}
        >
          <option value="">Choose an approved plank…</option>
          {available.map((p) => (
            <option key={p.handle} value={p.handle}>
              {p.displayName} (@{p.handle})
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || !selected || items.length >= 8}
          onClick={() => change(selected, true)}
        >
          Add to Top 8
        </button>
      </div>
      {items.length >= 8 && (
        <small>
          All eight slots are filled. Remove someone before adding another.
        </small>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}

export default function ProfileForm({
  editing = false,
}: {
  editing?: boolean;
}) {
  const [wallet, setWallet] = useState(""),
    [form, setForm] = useState(blank),
    [theme, setTheme] = useState(defaultTheme),
    [layout, setLayout] = useState(modules),
    [hiddenModules, setHiddenModules] = useState<string[]>([]),
    [step, setStep] = useState(1),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [saving, setSaving] = useState(false),
    [checking, setChecking] = useState(false),
    [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (editing) return;
    queueMicrotask(() => {
      try {
        const draft = JSON.parse(
          localStorage.getItem("plankspace-profile-draft") || "null"
        );
        if (draft?.form) setForm((v) => ({ ...v, ...draft.form }));
        if (draft?.theme) setTheme((v) => ({ ...v, ...draft.theme }));
        if (Array.isArray(draft?.layout))
          setLayout([
            ...draft.layout.filter((x: string) => modules.includes(x)),
            ...modules.filter((x) => !draft.layout.includes(x)),
          ]);
        if (Array.isArray(draft?.hiddenModules))
          setHiddenModules(
            draft.hiddenModules.filter((x: string) => modules.includes(x))
          );
        if (draft) setNotice("Recovered your unsaved profile draft.");
      } catch {}
    });
  }, [editing]);
  useEffect(
    () =>
      subscribePlankLoveWalletState((state) => {
        if (state.isConnected && state.address)
          setWallet(state.address.toLowerCase());
      }),
    []
  );
  useEffect(() => {
    if (editing || !form.handle) return;
    const { avatarData: _, ...draftForm } = form;
    void _;
    try {
      localStorage.setItem(
        "plankspace-profile-draft",
        JSON.stringify({ form: draftForm, theme, layout, hiddenModules })
      );
    } catch {}
  }, [editing, form, theme, layout, hiddenModules]);
  const set = (key: keyof FormState, value: string) => {
    setForm((v) => ({ ...v, [key]: value }));
    if (key === "handle") setAvailable(null);
  };
  const load = (p: Record<string, string>) => {
    setForm({
      handle: p.handle || "",
      displayName: p.displayName || "",
      bio: p.bio || "",
      hobbies: p.hobbies || "",
      interests: p.interests || "",
      music: p.music || "",
      heroes: p.heroes || "",
      lookingToMeet: p.lookingToMeet || "",
      avatarUrl: p.avatarUrl || "",
      mood: p.mood || "feeling board",
      moodText: p.moodText || "",
      featuredVideo: p.featuredVideo || "",
      customHtml: p.customHtml || "",
      customCss: p.customCss || "",
    });
    try {
      const saved = JSON.parse(p.layoutJson || "[]"),
        order = Array.isArray(saved)
          ? saved
          : Array.isArray(saved?.order)
          ? saved.order
          : [],
        hidden = Array.isArray(saved?.hidden) ? saved.hidden : [];
      if (order.length)
        setLayout([
          ...order.filter((x: string) => modules.includes(x)),
          ...modules.filter((x) => !order.includes(x)),
        ]);
      setHiddenModules(hidden.filter((x: string) => modules.includes(x)));
    } catch {}
    try {
      setTheme({ ...defaultTheme, ...JSON.parse(p.themeJson || "{}") });
    } catch {
      setTheme(defaultTheme);
    }
  };
  const connect = async () => {
    setError("");
    try {
      const address = await connectPlankLoveWallet();
      setWallet(address);
      const proof = await walletProof(address, "profile:read", address, {
        wallet: address,
      });
      if (editing) {
        const response = await fetch("/api/profiles", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(proof),
          }),
          result = await readApiJson<{
            profile?: Record<string, string>;
            error?: string;
          }>(response, "Could not load this wallet's profile.");
        if (result.profile) {
          load(result.profile);
          setNotice(
            `Editing @${result.profile.handle} · ${result.profile.moderationStatus}`
          );
        } else
          setError("No profile belongs to this wallet yet. Create one first.");
      }
      setStep(2);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Wallet connection was cancelled."
      );
    }
  };
  const checkHandle = async () => {
    const clean = form.handle
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "");
    if (clean.length < 3) {
      setError("Username must be at least 3 characters.");
      return false;
    }
    if (editing) {
      setAvailable(true);
      return true;
    }
    setChecking(true);
    setError("");
    const result = await fetch(`/api/profiles?availability=${clean}`).then(
      (r) => r.json()
    );
    const ok = Boolean(result.available);
    setAvailable(ok);
    setChecking(false);
    if (!ok) setError("That exact username is already taken.");
    return ok;
  };
  const next = async () => {
    if (await checkHandle()) setStep(3);
  };
  const save = async () => {
    const handle = form.handle
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, ""),
      profile = {
        ...form,
        displayName: form.displayName || handle,
        themeJson: theme,
        layout,
        hiddenModules,
      };
    setSaving(true);
    setError("");
    try {
      const proof = await walletProof(wallet, "profile:save", handle, {
        handle,
        profile,
      });
      const result = await fetch("/api/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...proof, wallet, handle, profile }),
      }).then((r) => r.json());
      if (result.error) throw new Error(result.error);
      localStorage.removeItem("plankspace-profile-draft");
      window.location.href = `/u/${handle}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Profile save failed.");
    } finally {
      setSaving(false);
    }
  };
  const move = (id: string, to: number) =>
    setLayout((v) => {
      const next = v.filter((x) => x !== id);
      next.splice(Math.max(0, Math.min(to, next.length)), 0, id);
      return next;
    });
  const toggleModule = (id: string) =>
    setHiddenModules((v) =>
      v.includes(id) ? v.filter((x) => x !== id) : [...v, id]
    );
  const videoLinks = form.featuredVideo
    ? form.featuredVideo.split("\n").slice(0, 8)
    : [""];
  const updateVideo = (index: number, value: string) => {
    const next = [...videoLinks];
    next[index] = value;
    set("featuredVideo", next.join("\n"));
  };
  const addVideo = () => {
    if (videoLinks.length < 8)
      set("featuredVideo", [...videoLinks, ""].join("\n"));
  };
  const removeVideo = (index: number) => {
    const next = videoLinks.filter((_, i) => i !== index);
    set("featuredVideo", (next.length ? next : [""]).join("\n"));
  };
  const moveVideo = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= videoLinks.length) return;
    const next = [...videoLinks];
    [next[index], next[target]] = [next[target], next[index]];
    set("featuredVideo", next.join("\n"));
  };
  return (
    <div className="onboard-shell">
      <header className="page-bar">
        <h1>{editing ? "Profile workshop" : "Profile carpentry"}</h1>
      </header>
      <main className="onboard-card profile-builder">
        <div className="onboard-progress">
          <i className={step >= 1 ? "active" : ""} />
          <i className={step >= 2 ? "active" : ""} />
          <i className={step >= 3 ? "active" : ""} />
        </div>
        {step === 1 && (
          <section>
            <div className="onboard-plank">
              <i />
              <i />
            </div>
            <small>{editing ? "WELCOME BACK" : "FIRST THINGS FIRST"}</small>
            <h1>
              {editing
                ? "Open your profile workshop."
                : "Claim your corner of the lumberyard."}
            </h1>
            <p>
              {wallet
                ? `Plank.love wallet ${wallet.slice(0, 6)}…${wallet.slice(
                    -4
                  )} is connected. Sign one safe verification message to prove ownership.`
                : "Connect once and sign one safe verification message to unlock this wallet's PlankSpace features for 12 hours."}
            </p>
            <div className="profile-access-actions">
              <button onClick={connect}>
                {wallet
                  ? editing
                    ? "Sign to Verify & Load Profile"
                    : "Sign to Verify & Create Profile"
                  : editing
                  ? "Connect Wallet, Verify & Load Profile"
                  : "Connect Wallet & Verify"}
              </button>
            </div>
            <em>
              The message cannot move funds, approve tokens, or access your
              keys.
            </em>
          </section>
        )}
        {step === 2 && (
          <section>
            <h1>Cut your board to fit.</h1>
            <code>
              {wallet.slice(0, 6)}…{wallet.slice(-4)}
            </code>
            <div className="builder-grid">
              <label>
                UNIQUE USERNAME
                <input
                  value={form.handle}
                  onChange={(e) => set("handle", e.target.value)}
                  placeholder="degenwaffle"
                  maxLength={24}
                  disabled={editing}
                />
                <span>
                  {editing
                    ? "Usernames stay permanent so links and comments never break."
                    : checking
                    ? "Checking…"
                    : available === true
                    ? "✓ Available"
                    : available === false
                    ? "Already taken"
                    : "Letters, numbers, _ and -"}
                </span>
              </label>
              <label>
                DISPLAY NAME
                <input
                  value={form.displayName}
                  onChange={(e) => set("displayName", e.target.value)}
                  placeholder="DegenWaffle"
                  maxLength={40}
                />
              </label>
              <label className="wide">
                UPLOAD PROFILE PICTURE
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (file.size > 2_000_000) {
                      setError("Profile pictures must be under 2 MB.");
                      return;
                    }
                    const reader = new FileReader();
                    reader.onload = () =>
                      setForm((v) => ({
                        ...v,
                        avatarData: String(reader.result || ""),
                      }));
                    reader.readAsDataURL(file);
                  }}
                />
                <span>PNG, JPEG, or WebP up to 2 MB.</span>
              </label>
              <label className="wide">
                OR USE AN HTTPS IMAGE URL
                <input
                  value={form.avatarUrl}
                  onChange={(e) => set("avatarUrl", e.target.value)}
                  placeholder="https://…"
                />
              </label>
            </div>
            <div className="avatar-preview">
              <img
                src={form.avatarData || form.avatarUrl || "/plank-classic.jpeg"}
                alt="Profile picture preview"
                onError={(e) => {
                  e.currentTarget.src = "/plank-classic.jpeg";
                }}
              />
            </div>
            <button onClick={next}>
              {editing ? "Continue Editing" : "Continue"}
            </button>
          </section>
        )}
        {step === 3 && (
          <section>
            <h1>Tell the lumberyard who you are.</h1>
            <div className="builder-grid">
              <label className="wide">
                BIO
                <textarea
                  value={form.bio}
                  onChange={(e) => set("bio", e.target.value)}
                  maxLength={500}
                />
              </label>
              <label>
                HOBBIES
                <textarea
                  value={form.hobbies}
                  onChange={(e) => set("hobbies", e.target.value)}
                  maxLength={500}
                />
              </label>
              <label>
                GENERAL INTERESTS
                <textarea
                  value={form.interests}
                  onChange={(e) => set("interests", e.target.value)}
                  maxLength={500}
                />
              </label>
              <label>
                MUSIC
                <textarea
                  value={form.music}
                  onChange={(e) => set("music", e.target.value)}
                  maxLength={500}
                />
              </label>
              <label>
                HEROES
                <textarea
                  value={form.heroes}
                  onChange={(e) => set("heroes", e.target.value)}
                  maxLength={500}
                />
              </label>
              <label className="wide">
                WHO I&apos;D LIKE TO MEET
                <textarea
                  value={form.lookingToMeet}
                  onChange={(e) => set("lookingToMeet", e.target.value)}
                  maxLength={500}
                />
              </label>
              <label>
                MOOD
                <select
                  value={form.mood}
                  onChange={(e) => set("mood", e.target.value)}
                >
                  <option>feeling board</option>
                  <option>building</option>
                  <option>bullish</option>
                  <option>chillin&apos;</option>
                  <option>knocked on wood</option>
                  <option>splintered</option>
                  <option>legendary</option>
                </select>
              </label>
              <label>
                STATUS UPDATE
                <input
                  value={form.moodText}
                  onChange={(e) => set("moodText", e.target.value)}
                  maxLength={140}
                />
              </label>
              <div className="wide youtube-link-editor">
                <b>YOUTUBE FEATURED VIDEOS — UP TO 8</b>
                <span>
                  Add, remove, and arrange the videos in playback order.
                </span>
                {videoLinks.map((link, index) => (
                  <div className="youtube-link-row" key={index}>
                    <label>
                      <span>VIDEO {index + 1}</span>
                      <input
                        value={link}
                        onChange={(e) => updateVideo(index, e.target.value)}
                        placeholder="https://youtube.com/watch?v=…"
                        maxLength={500}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => moveVideo(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move video ${index + 1} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveVideo(index, 1)}
                      disabled={index === videoLinks.length - 1}
                      aria-label={`Move video ${index + 1} down`}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => removeVideo(index)}
                      aria-label={`Remove video ${index + 1}`}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addVideo}
                  disabled={videoLinks.length >= 8}
                >
                  + Add Another Video ({videoLinks.length}/8)
                </button>
              </div>
              <label className="wide">
                PROFILE CSS — CHANGES THE WHOLE PAGE
                <span>
                  Paste plain CSS rules here. Do not include export const,
                  backticks, or a &lt;style&gt; wrapper.
                </span>
                <textarea
                  className="code-input"
                  value={form.customCss}
                  onChange={(e) => set("customCss", e.target.value)}
                  maxLength={24000}
                />
                <span className="custom-code-actions">
                  <button type="button" onClick={() => set("customCss", CYBERPUNK_PROFILE_CSS)}>
                    Load Cyberpunk Example
                  </button>
                  <button type="button" onClick={() => set("customCss", DEFAULT_PROFILE_CSS_GUIDE)}>
                    Load CSS Hook Guide
                  </button>
                  <button type="button" onClick={() => set("customCss", "")}>
                    Clear CSS / Restore Default
                  </button>
                </span>
              </label>
              <label className="wide">
                CUSTOM HTML — SANDBOXED MODULE
                <span>This content stays inside the movable Custom Space box.</span>
                <textarea
                  className="code-input"
                  value={form.customHtml}
                  onChange={(e) => set("customHtml", e.target.value)}
                  maxLength={20000}
                />
              </label>
            </div>
            <div className="module-editor">
              <h2>Arrange and show/hide every module</h2>
              <p>
                Hidden modules stay saved but do not appear on your public page.
              </p>
              {layout.map((id, i) => (
                <div
                  key={id}
                  className={hiddenModules.includes(id) ? "module-hidden" : ""}
                >
                  <b>{id}</b>
                  <em>{hiddenModules.includes(id) ? "Hidden" : "Visible"}</em>
                  <span>
                    <button type="button" onClick={() => toggleModule(id)}>
                      {hiddenModules.includes(id) ? "Show" : "Hide"}
                    </button>
                    <button
                      onClick={() => move(id, 0)}
                      disabled={i === 0}
                      aria-label={`Move ${id} to top`}
                    >
                      Top
                    </button>
                    <button
                      onClick={() => move(id, i - 1)}
                      disabled={i === 0}
                      aria-label={`Move ${id} up`}
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => move(id, i + 1)}
                      disabled={i === layout.length - 1}
                      aria-label={`Move ${id} down`}
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => move(id, layout.length - 1)}
                      disabled={i === layout.length - 1}
                      aria-label={`Move ${id} to bottom`}
                    >
                      Bottom
                    </button>
                  </span>
                </div>
              ))}
            </div>
            <div className="builder-actions">
              <button className="back-button" onClick={() => setStep(2)}>
                Back
              </button>
              <button onClick={save} disabled={saving}>
                {saving
                  ? "Saving…"
                  : editing
                  ? "Save Profile"
                  : "Create Profile"}
              </button>
            </div>
          </section>
        )}
        {step === 3 && (
          <section className="theme-workshop">
            <h1>Make the whole page yours.</h1>
            <p>
              These settings change your full profile and are saved to your
              wallet-owned page. Custom HTML and CSS still controls your Custom
              Space module.
            </p>
            <div className="theme-builder">
              <label>
                TEMPLATE
                <select
                  value={theme.template}
                  onChange={(e) =>
                    setTheme((v) => ({ ...v, template: e.target.value }))
                  }
                >
                  <option value="lounge">Walnut Lounge</option>
                  <option value="classic">Classic MySpace Blue</option>
                  <option value="midnight">Midnight Board</option>
                  <option value="neon">Neon Plank</option>
                </select>
              </label>
              <label>
                FONT
                <select
                  value={theme.fontFamily}
                  onChange={(e) =>
                    setTheme((v) => ({ ...v, fontFamily: e.target.value }))
                  }
                >
                  <option>Verdana</option>
                  <option>Georgia</option>
                  <option>Arial</option>
                  <option>Courier New</option>
                </select>
              </label>
              {(
                [
                  ["PAGE", "pageBackground"],
                  ["PANELS", "panelBackground"],
                  ["TEXT", "textColor"],
                  ["LINKS", "linkColor"],
                  ["HEADINGS", "headingColor"],
                  ["ACCENT", "accentColor"],
                ] as [string, ThemeColorKey][]
              ).map(([label, key]) => (
                <label key={key}>
                  {label}
                  <input
                    type="color"
                    value={theme[key]}
                    onChange={(e) =>
                      setTheme((v) => ({ ...v, [key]: e.target.value }))
                    }
                  />
                </label>
              ))}
            </div>
            <button onClick={save} disabled={saving}>
              {saving ? "Saving your space…" : "Save Design & Profile"}
            </button>
            {editing && wallet && form.handle && (
              <>
                <XConnectionManager wallet={wallet} handle={form.handle} />
                <WidgetManager wallet={wallet} handle={form.handle} />
              </>
            )}
          </section>
        )}
        {notice && (
          <p className="onboard-notice" role="status" aria-live="polite">
            {notice}
          </p>
        )}
        {error && (
          <p className="onboard-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <span>Wallet-owned profile</span>
          <b>Verified by Plank.love</b>
        </footer>
      </main>
    </div>
  );
}

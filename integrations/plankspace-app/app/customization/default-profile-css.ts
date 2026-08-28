export const DEFAULT_PROFILE_CSS_GUIDE = `/* PlankSpace public customization hooks.
   Removing this CSS always restores the default PlankSpace design. */
.plankspace-profile {
  /* Entire profile canvas. Override these semantic variables to recolor
     every nested PlankSpace surface, including feeds and composers. */
  /* --profile-bg: page background; */
  /* --profile-panel: module interiors; */
  /* --profile-text: body text; */
  /* --profile-link: links; */
  /* --profile-heading: module headings; */
  /* --profile-accent: borders and accents; */
  /* --profile-font: body font family; */
}
.profile-columns { /* sidebar + main column layout */ }
.profile-sidebar { /* owner identity rail */ }
.profile-main { /* ordered content modules */ }
.module-identity { /* profile photo and identity */ }
.module-contact { /* friend, mail, and knock actions */ }
.module-url { /* permanent profile URL */ }
.module-interests { /* owner interests */ }
.module-welcome { }
.module-status { }
.module-music { }
.module-video { }
.module-game { }
.module-custom { }
.module-collection { }
.module-about { }
.module-friends { }
.module-widgets { }
.module-feed { }
.module-comments { }
`;

export const CYBERPUNK_PROFILE_CSS = `/* NEON LUMBERYARD — paste into Profile CSS */
.plankspace-profile {
  --neon-cyan: #35f2ff;
  --neon-pink: #ff3cac;
  --void: #090b14;
  --profile-bg: #090b14 !important;
  --profile-panel: #0d1224 !important;
  --profile-text: #e9fbff !important;
  --profile-link: #ffe56b !important;
  --profile-heading: #35f2ff !important;
  --profile-accent: #ff3cac !important;
  --profile-font: var(--font-body) !important;
  color: var(--profile-text) !important;
  background: radial-gradient(circle at 20% 10%, #18294a 0, transparent 35%), linear-gradient(135deg, #090b14, #160b24) !important;
  font-family: var(--profile-font), sans-serif !important;
  padding: 18px;
}
.profile-columns { grid-template-columns: minmax(230px, 30%) minmax(0, 1fr); gap: 18px; }
.profile-sidebar, .profile-main { gap: 14px; }
.plankspace-profile .box,
.plankspace-profile .identity,
.plankspace-profile .profile-module,
.plankspace-profile .profile-module > section {
  color: var(--profile-text) !important;
  background: linear-gradient(145deg, rgba(13,18,36,.96), rgba(29,10,39,.94)) !important;
  border: 1px solid var(--neon-cyan) !important;
  box-shadow: 0 0 12px rgba(53,242,255,.28), inset 0 0 24px rgba(255,60,172,.06);
}
.plankspace-profile h1, .plankspace-profile h2 {
  color: var(--neon-cyan) !important;
  text-shadow: 2px 0 var(--neon-pink), 0 0 10px var(--neon-cyan);
  letter-spacing: .06em;
  text-transform: uppercase;
}
.plankspace-profile .interests dt {
  color: var(--profile-heading) !important;
  background: color-mix(in srgb, var(--profile-accent) 55%, var(--void)) !important;
}
.plankspace-profile .interests dd,
.plankspace-profile .feed article,
.plankspace-profile .public-knocks article {
  color: var(--profile-text) !important;
  background: var(--profile-panel) !important;
}
.plankspace-profile .contact button { color: var(--profile-link) !important; }
.plankspace-profile a { color: var(--profile-link) !important; }
.module-identity { border: 1px solid var(--neon-pink); padding: 12px; }
.module-feed { transform: translateZ(0); }
.module-feed:hover, .module-widgets:hover { filter: drop-shadow(0 0 9px var(--neon-pink)); }
@media (max-width: 760px) { .profile-columns { grid-template-columns: 1fr; } }
`;

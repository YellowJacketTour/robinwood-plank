# Powerboard cinematic presentation audit — 2026-08-30

## Decision

Powerboard is a real sixth act in every qualified PlankCrash round, not a badge inside the crash receipt. The presentation is a client-side interpretation of one authoritative `round.settled` event. It never chooses a number, changes a payout, delays settlement, or manufactures a near miss.

The sequence is: crash truth → personal accounting → chamber ignition → committed number lands → win/funding/rollover truth → world-state ledger → voluntary return. A player can skip it immediately. Reduced-motion users receive the same complete story without staged movement.

## Evidence applied

- Apple Human Interface Guidelines, [Motion](https://developer.apple.com/design/human-interface-guidelines/motion): motion must convey state, stay brief, be optional, and be cancelable. Applied as a skippable sequence, a static reduced-motion path, and no animation dependency for settlement.
- Apple Human Interface Guidelines, [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback): feedback should explain status and outcomes through more than one channel. Applied as synchronized text, visual state, short audio cues, and optional haptics.
- Apple Human Interface Guidelines, [Playing haptics](https://developer.apple.com/design/human-interface-guidelines/playing-haptics): haptics should have a consistent causal meaning, be brief, complement other feedback, and remain optional. Applied as distinct charge, ball-land, miss, and jackpot patterns behind the existing haptics preference.
- Apple Human Interface Guidelines, [Designing for games](https://developer.apple.com/design/human-interface-guidelines/designing-for-games): provide strong defaults, teach through play, support platform input, and personalize motion/sound. Applied through inline narrative instruction and existing motion, quality, sound, haptic, and fullscreen controls.
- W3C WCAG 2.2, [Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages): important state changes must be programmatically exposed without moving focus. Applied with `role=status` and `aria-live=polite` on the authoritative draw result.
- UK Gambling Commission game-design consultation, [losses disguised as wins and near misses](https://consult.gamblingcommission.gov.uk/author/game-design-consultation/supporting_documents/PDF%20of%20the%20consultation%20on%20online%20slots%20game%20design%20and%20reverse%20withdrawals1.pdf): a return below stake must not be celebrated as a win, and designed near-miss celebration is misleading. Applied by retaining PROFIT versus POOL DILUTED language and by showing only the actual bounded draw—no fake almost-winning balls.
- Powerball Product Group, [drawing equipment and production enhancements](https://www.powerball.com/exciting-enhancements-coming-powerball-draw-show): spectacle may change while drawing integrity remains independently secured. Applied by separating the committed server result from the client theater.
- Three.js, [official repository and MIT license](https://github.com/mrdoob/three.js): retain the established renderer and its existing post-processing instead of adding a second engine. The Powerboard theater is deliberately composited over the game scene.
- Howler, [official repository](https://github.com/goldfire/howler.js): reviewed for cross-browser and spatial-audio patterns. It was not added because the current Web Audio graph already provides the required short procedural cues without another runtime dependency.

## Authoritative and reconnect contract

1. The server derives one bounded draw from the committed round reveal.
2. The settlement event records the draw, actual lottery transition, winner if any, and exact Powerboard funding added by this flight.
3. The client derives presentation stages from that event. Timers only reveal already-settled facts.
4. Refresh/reconnect can replay the receipt but cannot reroll or repay it. Replacing a receipt clears all old reveal timers.
5. Host-forced laboratory outcomes are visibly labeled and are never presented as natural randomness.

## Art and licensing

`public/arcade/art/PowerboardMachine-v1.webp` is a bespoke generated RobinWood prop, not copied from an asset library. It is composited as transparent WebP and reduced to roughly 300 KB for mobile delivery. Existing Plank character art remains the scene anchor; the prop adds a wood/brass observatory vocabulary consistent with the product design system.

The source prompt was:

> Use case: stylized-concept. Asset type: transparent game prop for a cinematic browser-game lottery reveal. Create a single premium fantastical POWERBOARD lottery draw machine that belongs in the RobinWood PlankCrash universe, shaped like a handcrafted wooden observatory / brass cosmic lottery drum, with a circular glass chamber for numbered balls, mechanical wooden ribs, brass fittings, subtle violet energy conduits, warm amber practical lights, and charming hand-inked imperfections. High-end stylized 3D game prop blended with tactile hand-drawn storybook linework; physically believable wood, brass and glass; polished AAA mobile/browser game asset; whimsical rather than realistic casino branding. Centered isolated full prop, three-quarter front view, entire silhouette visible, generous transparent padding, suitable for compositing over a dark space scene. Cinematic warm amber key light, violet rim light, restrained luminous accents, inviting anticipation and wonder. Honey wood, aged brass, parchment cream, deep violet, small mint-green confirmation lights. Genuinely transparent background with clean alpha; no floor, scenery, characters, logos, brand names, text, letters, numbers, or watermark; glass chamber interior visible; readable silhouette at phone size. Avoid generic slot machine, photoreal casino, neon cyberpunk overload, flat vector icon, plastic toy appearance, weapons, and currency symbols.

Generated with the built-in image-generation model in transparent-background mode, then resized and encoded locally with Sharp. The intermediate 2.8 MB PNG was removed after the deployable WebP was verified.

## Acceptance gates

- No client random number or payout logic.
- Exact per-round funding delta displayed from server accounting.
- No user-controlled text inserted as HTML.
- Cancelable reveal; complete reduced-motion result.
- Minimum 44 px reveal controls and mobile reflow.
- Visual, textual, audio, and optional tactile outcomes agree.
- Losing or diluted results are never labeled wins.
- Webpack production build, TypeScript, simulation/property tests, and reconnect behavior pass before release.

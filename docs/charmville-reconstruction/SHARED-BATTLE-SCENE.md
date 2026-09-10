# Shared encounter presentation

Two real authenticated accounts now read the same persisted encounter HP and committed event stream. Nearby authorized participants are labeled Fighting or Watching; the controller retains encounter control. A subsequent bounded assist feature allows one explicitly invited nearby player to choose one move. The scene shows the preserved wild portrait and actual bound companion portrait/HP/status values. No friend or participant is fabricated.

Hit outlines occur only for a newly observed committed event with positive applied damage and an explicit target ID. Initial history and repeated event IDs do not replay the visual. This is acknowledgment feedback on static source portraits, not a claim that source attack animation has been implemented. Battle text uses applied rather than uncapped rolled damage.

The native viewport remains mounted during inspection. A read-only snapshot callback projects actual encounter state to the native adapter; it carries no credentials or authority to mutate the account. The actual two-account test verifies the watcher native filesystem contains the same HP and a nonzero effect sequence, and native CHARMVILLE_ENCOUNTER_STATE confirms consumption. Source Poochyena is visible after dismissing the intro with frame-sampled input.

`verify-shared-battle-scene.mjs` passes private-home invitation, shared encounter ID/HP, fighter/watcher roles, source portraits, committed hit feedback, no spectator battle controls, native state consumption and screenshot review. Evidence: `work/shared-battle-scene.png` and `work/shared-battle-native.png`. The native adapter and service have their own isolated validation; this browser check joins them through actual accounts.

Remaining gaps include full move animations, arbitrary species AI, capture, rewards, broad combat effects and production-scale spectators. Nearby participant visibility does not grant control, damage rights or economic authority. Existing maturity bars remain unchanged.


## Consented one-move assist

The controller can explicitly invite a nearby player. The invited player sees a source portrait, their available move and PP, and a warning that Poochyena may retaliate. The helper must choose the move; invitation alone does not attack. Authorization comes from the server snapshot, and the helper cannot switch the controller’s party or take over the encounter. After the one-use grant is consumed, helper controls disappear on the next authoritative encounter refresh. Invitation expiry is displayed; failed uncertain invitations retain the same request ID for retry. Identity-keyed unmount aborts pending reads and drops old controls.

`verify-battle-assist.mjs` passed with two newly created real local test accounts: private-home admission, keyboard invitation, one helper attack, actual wild HP reduction, helper HP retaliation, unchanged controller, consumed grant and denied subsequent helper battle reads. The iframe remains mounted. `work/assist-mobile.png` was inspected at a 390-pixel viewport. This is a single consented assist, not simultaneous unrestricted combat, a raid system or autonomous companion AI.


The assist browser verifier also initializes the helper’s native runtime and waits for that account’s exact owned follower UUID before acting. A real committed assist reached source playback: `CHARMVILLE_ATTACK_CONTACT 277 ROW 2`, matched follower slot 1, and native end-of-animation acknowledgement. The recorded run dealt 6 applied damage, taking the shared wild HP from 13 to 7. `work/assist-native-log.txt` preserves the consumption evidence; `work/assist-native.png` is a post-animation screenshot, not proof of every animation frame. No event injection was used in this account-to-native regression. Frame-by-frame source fidelity remains a separate native validation responsibility.

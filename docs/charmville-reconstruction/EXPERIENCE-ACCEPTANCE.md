# Experience acceptance, not only state correctness

Every shipped interaction needs both a transaction acceptance test and a visible playthrough. A correct balance is not proof that the action feels right. A working source game is not proof that its art fits a different actor.

## Source-grounded rules

Solarus treats the hero as coordinated body, shield, sword and other sprites. Sprite facing can differ from input or movement direction; missing animations can hide an equipment sprite. Our adapters must therefore name facing independently, synchronize equipment with the actor state, and explicitly validate missing layers. Do not infer sprite direction from velocity alone. [Solarus hero API](https://docs.solarus-games.org/lua-api/map-entities/hero/).

Solarus animation sets declare per-direction frames, frame timing and an origin used to align differently sized art. Our source adapters must retain those properties or explicitly translate them. Equal-sized atlas cells are not evidence of equal hand anchors or a contiguous frame sequence. [Solarus sprite API](https://docs.solarus-games.org/lua-api/drawable-objects/sprite/).

The local LPC watering definition uses frames 0,1,4,4,4,4,5. Playing every intervening column hid the watering can. The native correction follows that sequence; hoe playback now includes all eight source frames. These are verified source metadata corrections, not a claim that generic Link body poses have become bespoke farming poses.

## Playthrough gate for every action

1. The player can tell what object will be affected and why their tool applies.
2. Confirm begins the expected motion immediately; unavailable actions explain their requirement without spending resources.
3. Facing remains intentional through windup, contact and recovery. Character hands, held object and target agree spatially.
4. The effect frame lines up with material-specific sound, particles and the visible world change. A text counter is insufficient.
5. Interrupting before contact spends nothing; interrupting afterward never repeats or reverses the committed effect. Scene changes clear temporary visual attachments.
6. North, south, east and west each pass runtime inspection. Foreground/background layering, shadows and target collision must all agree.
7. A second player sees the same committed outcome. Local prediction may smooth motion but cannot mint items.
8. Keyboard, touch and controller can complete the action without accidental menu activation. Reduced-effects settings preserve useful cues.

## Travel and social acceptance

Travel requires a readable destination, safe arrival, preserved identity/inventory and no stuck inputs. Account region membership alone does not meet the map-transition gate. Until native map bindings exist, the account shell must disclose that its reference camera is separate.

Inviting a friend clearly states what they may do. Revocation blocks subsequent effects. Presence lists show authenticated live leases, never invented players. Wallet changes clear previous account state and pending requests. Source quest scripts never receive bearer credentials.

Trade screens disclose side, quantity, unit price and total before submission. Escrow explains why balances change before a sale. Failed requests preserve funds; ambiguous network failures reuse the same request ID before any fresh action. Cancelling returns only the unfilled remainder. A fixed-price offer board is not advertised as automatic order matching or a derivatives market.

## Remaining visual acceptance gaps

Tool atlas coverage is tested across four directions; current runtime frame captures do not prove all four body/hand alignments. Transformation hair remains stylistically mismatched. Native private home maps, creature encounters, followers, mining/fishing loops and public construction still need authored art and playable integration. Do not advance their quality bars based on domain tests.

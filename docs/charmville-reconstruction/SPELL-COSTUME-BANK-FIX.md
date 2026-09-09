# Spell costume-bank defect — 2026-09-09

Reproduced in original Hero of Dreams with full endgame kit: Divine Fire (64) switches to a visibly split character after the returning crystal. Minimal spell, golden ring (61), mirror shield (93) were intact. Adding sword slot 36 alone reproduced it.

Native runtime trace in derived quest: casting base+modifier was 46804, sword TileMod was 46800. Initial hold pose was 46832. Source zelda.cpp switches from two-hand hold to cast on castnext; weapons.cpp sets castnext on returning projectile landing. The optional sword costume bank is the isolated defect; this is not caused by the farming overlay or toolbar.

Applied to Homestead.zs only: set itemdata for sword36 TileMod to 0 at initialization. Keeps sword item, weapon sprite, damage and abilities but uses the coherent base hero animation bank, with palette equipment still applied. Original quest/art source archive is unchanged. This is a costume-bank fallback, not a repaint or a repair of every frame inside the incomplete bank. The source quest test links can still reproduce the original defect.

Verified visual Fire capture with sword36/ring61/shield93 in the corrected homestead. Divine Protection shares the cast pose and is part of the follow-up capture. Escape uses different pound/stab/disintegration poses; all directions, all equipment combinations and every action have not been certified.

Corrected entry: http://localhost:3021/charmville/tutorial/
Evidence: chat outputs/fire-audit, fire-ring, fire-shield, fire-sword, full-kit, fire-fixed, protection-fixed, spell-regression. The split and corrected captures are fire-sword/fire-7.png and fire-fixed/fire-7.png.

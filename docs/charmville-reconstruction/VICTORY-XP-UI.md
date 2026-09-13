# Committed victory experience

Battle UI displays only the committed victory receipt: XP gained, resulting total, and a level change when one actually occurs. The supported award is the controller finishing strike; it does not claim full participant or shared-party allocation. Assisted final blows explicitly report pending allocation and zero awarded XP, and the assist prompt warns of that limitation before the action.

Party Summary reads persisted experience and the source level interval from the vitals service. The meter measures progress within that interval, and level 100 has no next-level bar. No client-side XP is minted and capture does not imply an experience reward.

`verify-victory-xp.mjs` passed an actual isolated account fight: the native creature reached DEFEAT_START and DEFEAT_COMPLETE, the winning receipt awarded 15 XP in the recorded run, receipt replay preserved the award, and Party showed the same persisted total and next-level progress. `work/victory-xp.png` was inspected; it showed 150 total XP and 29 to the next level. This run did not cross a level boundary; level-up mathematics and replay behavior are separately covered by service tests.

// Native quest test-mode arguments, not replacement movement/combat code.
// DMap/screen: upstream tests/replays/hero_of_dreams/hero_of_dreams_8_of_8.zplay.
// Item IDs: upstream src/core/zdefs.h; counters: src/base/general.h.
// Only equipment; deliberately excludes story relics, scripted rewards and kill-all.
// Names are engine defaults: authored quests can rename/reconfigure these slots.
export const endgameEquipment = [
  [36,'Master sword'], [3,'Bombs'], [48,'Super bombs'], [57,'Golden arrows'],
  [68,'Upgraded bow'], [35,'Fire boomerang'], [25,'Wand'], [11,'Red candle'],
  [26,'Raft'], [27,'Ladder'], [30,'Red potion'], [31,'Whistle'], [33,'Magic key'],
  [51,'Flippers'], [89,'Longshot'], [53,'Lens'], [54,'Hammer'], [55,'Boots'],
  [56,'Power bracelet'], [61,'Golden ring'], [64,'Divine fire'],
  [65,'Divine escape'], [66,'Divine protection'], [88,'Cane of Byrna'],
  [91,'Roc feather'], [92,'Hover boots'], [93,'Mirror shield'],
  [94,'Spin scroll'], [95,'Cross scroll'], [96,'Quake scroll'],
  [97,'Super quake scroll'], [98,'Super spin scroll'], [102,'Fast charge ring'],
  [104,'Large wallet'], [105,'Large quiver'], [106,'Large bomb bag'],
  [114,'Life regeneration ring'], [118,'Magic regeneration ring'],
];
const equipmentDelta=endgameEquipment.map(([id])=>`items[${id}]=1`).join(' ');
export const adventureEntry = {
  quest: '/quests/purezc/139/r01/HeroOfDreams.qst',
  dmap: 4,
  screen: 63,
  name: 'Autumn Town',
  persistent: false,
  initData: equipmentDelta+' flags[1]=1 counter[0]=320 mcounter[0]=320 counter[1]=999 mcounter[1]=999 counter[2]=99 mcounter[2]=99 counter[3]=99 mcounter[3]=99 counter[4]=256 mcounter[4]=256 counter[5]=99 mcounter[5]=99 counter[6]=24',
};
export const diagnosticKits = {
  bow: {label:'Bow timing',delta:'items[13]=1 items[15]=1 counter[1]=100 counter[3]=30 mcounter[3]=30'},
  bomb: {label:'Bomb fuse',delta:'items[3]=1 counter[2]=8 mcounter[2]=8'},
  wand: {label:'Wand effect',delta:'items[25]=1 counter[4]=64 mcounter[4]=64'},
  fire: {label:'Divine fire',delta:'items[64]=1 counter[4]=64 mcounter[4]=64'},
  sword: {label:'Sword charge timing',delta:'items[5]=1 items[94]=1 items[98]=1 flags[1]=1 counter[4]=128 mcounter[4]=128'},
};
export function adventureUrl(kit='endgame') {
  return '/play/?' + new URLSearchParams({
    test: adventureEntry.quest, dmap: String(adventureEntry.dmap),
    screen: String(adventureEntry.screen), storage: 'idb',
    testInitData: diagnosticKits[kit]?.delta ?? adventureEntry.initData,
  });
}

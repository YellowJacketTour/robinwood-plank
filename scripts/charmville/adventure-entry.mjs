// Native quest test-mode arguments, not replacement movement/combat code.
// DMap/screen: upstream tests/replays/hero_of_dreams/hero_of_dreams_8_of_8.zplay.
// Item IDs: upstream src/core/zdefs.h; counters: src/base/general.h.
export const adventureEntry = {
  quest: '/quests/purezc/139/r01/HeroOfDreams.qst',
  dmap: 4,
  screen: 63,
  name: 'Autumn Town',
  persistent: false,
  initData: 'items[5]=1 items[3]=1 items[13]=1 items[15]=1 items[23]=1 items[25]=1 counter[1]=100 counter[2]=8 mcounter[2]=8 counter[3]=30 mcounter[3]=30 counter[4]=64 mcounter[4]=64',
};
export function adventureUrl() {
  return '/play/?' + new URLSearchParams({
    test: adventureEntry.quest, dmap: String(adventureEntry.dmap),
    screen: String(adventureEntry.screen), storage: 'idb',
    testInitData: adventureEntry.initData,
  });
}

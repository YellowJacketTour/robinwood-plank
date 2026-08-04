export type BoardSide = "good_wood" | "bad_boards" | "neutral" | "fallen";

/** Where the bad activity came from — never plank.love widget. */
export type BadVenue = "death_trap" | "off_site";

export type BadBoardEntry = {
  address: string;
  /** ISO timestamp first seen */
  firstSeenAt: string;
  lastSeenAt: string;
  reason: string;
  /** Was previously on Good Wood (mint / airdrop) */
  wasGoodWood: boolean;
  sources: string[];
  txHashes: string[];
  /**
   * Cumulative native ETH (wei, decimal string) spent by this wallet on
   * off-widget snipes — sum of tx.value for txs they signed.
   */
  ethSpentWei: string;
  /**
   * death_trap = bought while widget locked (Uniswap / bots / external).
   * off_site   = bought after open without a plank.love widget session.
   */
  venue?: BadVenue;
  /** Human label for ledger / CSV (e.g. "Uniswap / external") */
  venueLabel?: string;
  /** ETH spent fixed to 3 decimals (derived; always recomputed for clients). */
  ethSpent?: string;
  /** USD equivalent at last known ETH price (derived on read). */
  ethSpentUsd?: number;
  ethSpentUsdLabel?: string;
  /**
   * Reputation decay — see lib/boards.ts's nextGoodStreakDays /
   * decayedBadSeverity. Consecutive calendar days of recorded good
   * behavior (recordGoodBehavior in lib/boards-store.ts) since the mark,
   * with no new bad mark breaking the streak. Never negative, never
   * mutated except by that one function.
   */
  goodStreakDays?: number;
  /** ISO timestamp of the most recent good-behavior tick, if any. */
  lastGoodMarkAt?: string;
};

/** Good Wood / nice column with provenance. */
export type NiceLedgerEntry = {
  address: string;
  /** plank.love = official widget; wood_list = mint allowlist */
  label: "plank.love" | "wood_list";
};

export type WidgetSession = {
  address: string;
  firstSeenAt: string;
  lastSeenAt: string;
  quoteCount: number;
  swapCount: number;
};

export type WalletCooldown = {
  address: string;
  /** First on-chain or widget activity that started the 30m clock */
  startedAt: string;
  endsAt: string;
};

export type BoardsState = {
  updatedAt: string;
  widgetSessions: Record<string, WidgetSession>;
  badBoards: Record<string, BadBoardEntry>;
  cooldowns: Record<string, WalletCooldown>;
  /** Last block scanned for PLANK transfers */
  lastScannedBlock: number;
  /** ISO time of last successful chain scan (not polluted by widget pings) */
  lastScanAt?: string;
  scanNotes: string[];
  /** Aggregate ETH sniped (wei string) across all Bad Boards */
  totalEthSpentWei?: string;
};

export type BoardsVolumeTick = {
  /** Server wall clock */
  serverNow: string;
  ethUsd: number;
  ethUsdSource: string;
  totalEthSpent: string;
  totalEthSpentWei: string;
  totalUsd: number;
  totalUsdLabel: string;
  badBoards: number;
  fallen: number;
};

export type BoardsPublicView = {
  trap: {
    active: boolean;
    phase: "pre_lp" | "death_trap" | "cooldown_window" | "free";
    trapStartsAt: string;
    tradeOpensAt: string;
    cooldownsEndAt: string;
    sniperTrapMinutes: number;
    walletCooldownMinutes: number;
    serverNow: string;
  };
  counts: {
    goodWood: number;
    badBoards: number;
    widgetVerified: number;
    fallen: number;
  };
  /** Newest first */
  recentBadBoards: BadBoardEntry[];
  volume: BoardsVolumeTick;
  legend: {
    goodWood: string;
    badBoards: string;
    fallen: string;
    cooldown: string;
    plankLove: string;
    offSite: string;
  };
};

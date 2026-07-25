export type BoardSide = "good_wood" | "bad_boards" | "neutral" | "fallen";

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
  scanNotes: string[];
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
  legend: {
    goodWood: string;
    badBoards: string;
    fallen: string;
    cooldown: string;
  };
};

// $PLANK token contract. The RobinWood NFT mint contract is defined separately
// in lib/mint-contract.ts.
export const CONTRACT_ADDRESS = "0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc";

export const SITE_URL = "https://plank.love";

export const NAV_LINKS = [
  { href: "#home", label: "Home" },
  { href: "#mint", label: "Mint" },
  { href: "#tokenomics", label: "Funding" },
  { href: "#roadmap", label: "Roadmap" },
  { href: "#liquidity", label: "Liquidity" },
  { href: "#get-ready", label: "Get Ready" },
] as const;

export const SOCIAL_LINKS = {
  twitter: "https://x.com/RobinWoodPlank",
} as const;

// Official whitelist thread — drop your wallet address in the replies.
export const WHITELIST_TWEET_URL =
  "https://x.com/RobinWoodPlank/status/2079327510458982752";

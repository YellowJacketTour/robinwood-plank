export const NFT_CONTRACT_ADDRESS =
  "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_CHAIN_HEX_ID = "0x1237";

/** Preferred public RPC; overridable in Vercel. */
export const ROBINHOOD_RPC_URL =
  process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ||
  "https://robinhoodchain.blockscout.com/api/eth-rpc";

/**
 * Fallback list for browser reads. Prefer Blockscout eth-rpc (reliable + CORS),
 * then the official Robinhood public RPC.
 */
export const ROBINHOOD_RPC_URLS: string[] = Array.from(
  new Set(
    [
      process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL,
      "https://robinhoodchain.blockscout.com/api/eth-rpc",
      "https://rpc.mainnet.chain.robinhood.com",
    ].filter((url): url is string => Boolean(url && url.trim())),
  ),
);

export const ROBINHOOD_EXPLORER_URL = "https://robinhoodchain.blockscout.com";

export const NFT_ABI = [
  "function salePhase() view returns (uint8)",
  "function paused() view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function communityMintsClaimed() view returns (uint256)",
  "function freeMintsClaimed() view returns (uint256)",
  "function allowlistMintsClaimed() view returns (uint256)",
  "function paidMintsClaimed() view returns (uint256)",
  "function remainingCommunitySupply() view returns (uint256)",
  "function remainingTotalSupply() view returns (uint256)",
  "function remainingNonCommunitySupply() view returns (uint256)",
  "function communitySupplyReleased() view returns (bool)",
  "function mintPrice() view returns (uint256)",
  "function remainingFreeMintsForWallet(address wallet) view returns (uint256)",
  "function remainingAllowlistMintsForWallet(address wallet) view returns (uint256)",
  "function remainingPaidMintsForWallet(address wallet) view returns (uint256)",
  "function freeMint(uint256 quantity)",
  "function allowlistMint(uint256 quantity, bytes32[] merkleProof)",
  "function publicMint(uint256 quantity) payable",
  // Collection viewer (ERC-721 Enumerable + metadata)
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function tokenByIndex(uint256 index) view returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function nextTokenId() view returns (uint256)",
] as const;

export const SALE_PHASE_NAMES = [
  "Closed",
  "Free Mint",
  "Wood List Mint",
  "Paid Mint",
] as const;

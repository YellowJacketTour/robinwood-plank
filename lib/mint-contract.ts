export const NFT_CONTRACT_ADDRESS =
  "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156";

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_CHAIN_HEX_ID = "0x1237";
export const ROBINHOOD_RPC_URL =
  process.env.NEXT_PUBLIC_ROBINHOOD_RPC_URL ||
  "https://rpc.mainnet.chain.robinhood.com";
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
] as const;


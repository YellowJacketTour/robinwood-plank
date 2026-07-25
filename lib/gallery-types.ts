import type { NftAttribute } from "@/lib/ipfs";

export type GalleryNft = {
  tokenId: number;
  tokenUri: string;
  name: string;
  description: string;
  imageUri: string;
  attributes: NftAttribute[];
  owner: string;
  searchText: string;
  searchWords: string[];
  loaded: boolean;
  error?: string;
};

import { BrowserProvider, Contract, parseEther } from "ethers";
import vaultAbi from "@/lib/market/vault-abi.json";
import { CHAIN, MARKET_VAULT_ADDRESS } from "@/lib/constants";
import { ensureRobinhoodChain, getEthereumProvider } from "@/lib/wallet";

/**
 * Thin ethers wrapper around contracts/MarketplankVault.sol — UNAUDITED, not
 * deployed. Every function here throws immediately if MARKET_VAULT_ADDRESS
 * isn't set, so this can't silently point at nothing. See
 * docs/marketplank/SPEC.md §7 before this address is ever configured.
 */
async function getVaultContract() {
  if (!MARKET_VAULT_ADDRESS) {
    throw new Error("No liquidity vault deployed for this collection yet.");
  }
  await ensureRobinhoodChain();
  const injected = getEthereumProvider();
  if (!injected) throw new Error("No wallet found.");

  const provider = new BrowserProvider(injected, { chainId: CHAIN.id, name: CHAIN.name });
  const signer = await provider.getSigner();
  return new Contract(MARKET_VAULT_ADDRESS, vaultAbi, signer);
}

export async function depositForShares(tokenId: string): Promise<string> {
  const vault = await getVaultContract();
  const tx = await vault.deposit(tokenId);
  const receipt = await tx.wait();
  return receipt.hash as string;
}

export async function buyShares(
  ethAmount: string,
  minSharesOut: bigint = BigInt(0)
): Promise<string> {
  const vault = await getVaultContract();
  const tx = await vault.buyShares(minSharesOut, { value: parseEther(ethAmount) });
  const receipt = await tx.wait();
  return receipt.hash as string;
}

export async function sellShares(
  sharesWei: bigint,
  minEthOut: bigint = BigInt(0)
): Promise<string> {
  const vault = await getVaultContract();
  const tx = await vault.sellShares(sharesWei, minEthOut);
  const receipt = await tx.wait();
  return receipt.hash as string;
}

export async function redeemRandom(): Promise<string> {
  const vault = await getVaultContract();
  const tx = await vault.redeemRandom();
  const receipt = await tx.wait();
  return receipt.hash as string;
}

export async function redeemTarget(tokenId: string): Promise<string> {
  const vault = await getVaultContract();
  const tx = await vault.redeemTarget(tokenId);
  const receipt = await tx.wait();
  return receipt.hash as string;
}

export async function getVaultShareBalance(account: string): Promise<bigint> {
  const vault = await getVaultContract();
  return vault.balanceOf(account);
}

export async function getVaultHeldCount(): Promise<bigint> {
  const vault = await getVaultContract();
  return vault.heldTokenCount();
}

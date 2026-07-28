import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Shared fixture helpers for the vault suites after the drand rework.
 *
 * The vault no longer seeds from blockhash, so "mine one block and claim" is
 * replaced everywhere by "relay the target drand round and claim". These
 * helpers do exactly that against DrandBeaconMock — the vault-level suites are
 * about the vault's logic, and carrying real BLS fixtures through them would
 * add nothing. The real cryptography is proved, unmocked, in
 * DrandBeacon.bls.test.ts.
 */

/** Mock beacon on a 1-second period so one mined block ≈ one round. */
export async function deployBeaconMock(period = 1): Promise<any> {
  const genesis = await time.latest();
  const Mock = await ethers.getContractFactory("DrandBeaconMock");
  return await Mock.deploy(period, genesis);
}

/**
 * Publish the round the vault's in-flight request is waiting on, exactly as a
 * permissionless relayer would. `salt` varies the value so tests that want a
 * different draw can ask for one.
 *
 * Returns the round, or null if there is no pending request.
 */
export async function relayPendingRound(
  vault: any,
  beacon: any,
  salt = 0
): Promise<bigint | null> {
  const [round] = await vault.pendingRound();
  if (round === 0n) return null;
  const value = ethers.keccak256(
    ethers.solidityPacked(["uint64", "uint256"], [round, salt])
  );
  await beacon.setRandomness(round, value);
  return round;
}

/** The seed the vault will use for a round already relayed on the mock. */
export async function seedFor(beacon: any, round: bigint): Promise<string> {
  return await beacon.randomnessAt(round);
}

/** Push time far enough forward that a target round counts as expired. */
export async function expireRounds(periodSeconds = 1): Promise<void> {
  // ROUND_EXPIRY in the vault is 28_800 rounds; overshoot generously.
  await time.increase(periodSeconds * 30_000);
}

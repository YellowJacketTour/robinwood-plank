import hre from "hardhat";

/** One explicit Hardhat 3 connection shared by each contract-test module. */
export const { ethers, networkHelpers, provider } = await hre.network.create();

/**
 * LOCAL-ONLY PlankDerby dev stack. Deploys PlankDerby to a running Hardhat
 * node with fast, playable race timings. See local-crash-setup.ts for the
 * same pattern -- same test-account key derivation, same usage shape.
 *
 * Usage (two terminals):
 *   1)  npx hardhat node
 *   2)  npx hardhat run scripts/local-derby-setup.ts --network localhost
 *
 * Then open public/arcade/derby.html and paste the printed address.
 */
import hardhat from "hardhat";
const { ethers } = await hardhat.network.create();

async function main() {
  const [deployer, treasury] = await ethers.getSigners();

  const BETTING_SECONDS = 20;
  const REVEAL_DELAY_BLOCKS = 2;
  const REGISTRATION_WINDOW_BLOCKS = 50;
  const RAKE_BPS = 250n; // 2.5%
  const MIN_PARTICIPANTS = 2n;
  const MIN_POOL = ethers.parseEther("0.01");
  const MAX_STAKE_BPS = 6000n; // 60%
  const KEEPER_REWARD_BPS = 1000n; // 10% of the rake, same convention as crash's local setup

  const Derby = await ethers.getContractFactory("PlankDerby");
  const derby = await Derby.deploy(
    BETTING_SECONDS,
    REVEAL_DELAY_BLOCKS,
    REGISTRATION_WINDOW_BLOCKS,
    RAKE_BPS,
    MIN_PARTICIPANTS,
    MIN_POOL,
    MAX_STAKE_BPS,
    KEEPER_REWARD_BPS,
    treasury.address
  );
  await derby.waitForDeployment();
  const derbyAddr = await derby.getAddress();

  const player = process.env.PLAYER_ADDRESS;
  if (player && /^0x[0-9a-fA-F]{40}$/.test(player)) {
    await deployer.sendTransaction({ to: player, value: ethers.parseEther("50") });
    console.log(" Funded PLAYER", player, "-> 50 ETH");
  }

  // Derived from the standard Hardhat mnemonic ("test test test ... junk"),
  // m/44'/60'/0'/0/{0..4} -- verified against this node's real reported
  // addresses before ever being hardcoded here (see local-crash-setup.ts's
  // history: a from-memory copy of these was wrong once, don't repeat that).
  const HH_KEYS = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  ];

  console.log("\n========================================================");
  console.log(" PlankDerby local dev stack is live on http://127.0.0.1:8545 (chainId 31337)");
  console.log("========================================================");
  console.log(" PlankDerby address :", derbyAddr);
  console.log(" Treasury (acct #1) :", treasury.address);
  console.log(" Horses             : 6 (id 0-5)");
  console.log(" Betting window     :", BETTING_SECONDS, "seconds");
  console.log(" Reveal delay       :", REVEAL_DELAY_BLOCKS, "blocks after lock");
  console.log(" Whale cap          :", (Number(MAX_STAKE_BPS) / 100).toFixed(0) + "%");
  console.log(" Min pool / players :", ethers.formatEther(MIN_POOL), "ETH /", MIN_PARTICIPANTS.toString());
  console.log("\n--- paste into public/arcade/derby.html's config, or your wallet ---");
  console.log(" DERBY_ADDRESS =", `"${derbyAddr}"`);
  console.log("\n--- wallet import keys (LOCAL ONLY, never used against real value) ---");
  ["deployer", "treasury", "alice", "bob", "carol"].forEach((name, i) => {
    console.log(" " + name.padEnd(9), HH_KEYS[i]);
  });
  console.log(" Add network: RPC http://127.0.0.1:8545 · chainId 31337 · symbol ETH");
  console.log("========================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

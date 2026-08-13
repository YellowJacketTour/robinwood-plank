/**
 * LOCAL-ONLY PlankCrashV2 dev stack. Deploys PlankCrashV2 (real
 * reveal/settle split, presetCashOut, estimatedPayout, keeper reward --
 * see contracts/PlankCrashV2.sol's own header for the full design) to a
 * running Hardhat node with fast, playable round timings, and funds a
 * few test accounts so the arcade page can be exercised end-to-end
 * without any mainnet.
 *
 * Usage (two terminals):
 *   1)  npx hardhat node
 *   2)  npx hardhat run scripts/local-crash-v2-setup.ts --network localhost
 *
 * Then open public/arcade/crash.html (see console output for the printed
 * address) and import test account key(s) into your wallet, or drive it
 * with the printed keys directly via ethers in a browser console.
 */
import hardhat from "hardhat";
const { ethers } = await hardhat.network.create();

async function main() {
  const [deployer, treasury, alice, bob, carol] = await ethers.getSigners();

  // Real ~100ms Robinhood Chain block cadence (confirmed via research,
  // see contracts/PlankCrashV2.sol's _multiplierAt comment) -- matched
  // exactly, not approximated, so the local playtest actually reflects
  // real mainnet pacing rather than an arbitrary "feels right" number.
  // public/arcade/crash.html's LOCAL_BLOCK_MS constant must equal this.
  await ethers.provider.send("evm_setIntervalMining", [100]);

  const BETTING_SECONDS = 8;
  // Real entropy-source delay -- just enough blocks that blockhash(entropyBlock)
  // doesn't exist yet at lock time (closes the reveal-ordering exploit;
  // see the contract header). Small and fast at 100ms/block.
  const ENTROPY_DELAY_BLOCKS = 5;
  // Real max round duration in blocks. At 100ms/block and the re-derived
  // curve (10000 + 40*e + e^2/5 bps), 1800 blocks = 180 real seconds =
  // _multiplierAt(1800) = 10000 + 72000 + 648000 = 730000bps = 73.0x --
  // an honestly-advertisable real ceiling, not V1's disconnected phantom
  // tail. Tunable; this is the actual knob for "how long can a round run
  // and how high can it really go."
  const MAX_ELAPSED_BLOCKS = 1800;
  const REGISTRATION_WINDOW_BLOCKS = 50; // ~5s at 100ms/block
  const RAKE_BPS = 250n; // 2.5%
  const MIN_PARTICIPANTS = 2n;
  const MIN_POOL = ethers.parseEther("0.01");
  const MAX_STAKE_BPS = 6000n; // 60% -- generous for a small local test pool
  // 10% of the RAKE (never of players' distributable pool) paid to
  // whoever calls settleRound() -- see keeperRewardBps's own comment.
  const KEEPER_REWARD_BPS = 1000n;

  const Crash = await ethers.getContractFactory("PlankCrashV2");
  const crash = await Crash.deploy({
    bettingDurationSeconds: BETTING_SECONDS,
    roundIntervalSeconds: 0, // opt out of daily-grid scheduling locally -- every round reopens immediately
    entropyDelayBlocks: ENTROPY_DELAY_BLOCKS,
    maxElapsedBlocks: MAX_ELAPSED_BLOCKS,
    registrationWindowBlocks: REGISTRATION_WINDOW_BLOCKS,
    rakeBps: RAKE_BPS,
    minParticipants: MIN_PARTICIPANTS,
    minPoolSize: MIN_POOL,
    maxStakePerWalletBps: MAX_STAKE_BPS,
    keeperRewardBps: KEEPER_REWARD_BPS,
    treasury: treasury.address,
  });
  await crash.waitForDeployment();
  const crashAddr = await crash.getAddress();

  const Nft = await ethers.getContractFactory("MockRobinWoodNftEnumerable");
  const nft = await Nft.deploy();
  await nft.waitForDeployment();
  const nftAddr = await nft.getAddress();
  const AVATARS = [
    { id: 1334, holder: deployer, name: "Chalkstronaut", file: "Chalkstronaut4.png" },
    { id: 889, holder: alice, name: "ChalkPirate", file: "ChalkPirate4.png" },
    { id: 655, holder: bob, name: "ChalkStash", file: "ChalkStash4.png" },
    { id: 1099, holder: carol, name: "ChalkBaller", file: "ChalkBaller4.png" },
  ];
  for (const a of AVATARS) await (await nft.mint(a.holder.address, a.id)).wait();

  const player = process.env.PLAYER_ADDRESS;
  if (player && /^0x[0-9a-fA-F]{40}$/.test(player)) {
    await deployer.sendTransaction({ to: player, value: ethers.parseEther("50") });
    console.log(" Funded PLAYER", player, "-> 50 ETH");
  }

  const HH_KEYS = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0 deployer
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1 treasury
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2 alice
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3 bob
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // #4 carol
  ];

  console.log("\n========================================================");
  console.log(" PlankCrashV2 local dev stack is live on http://127.0.0.1:8545 (chainId 31337)");
  console.log("========================================================");
  console.log(" PlankCrashV2 address :", crashAddr);
  console.log(" Treasury (acct #1)   :", treasury.address);
  console.log(" Betting window       :", BETTING_SECONDS, "seconds");
  console.log(" Entropy delay        :", ENTROPY_DELAY_BLOCKS, "blocks after lock");
  console.log(" Max round duration   :", MAX_ELAPSED_BLOCKS, "blocks (~" + (MAX_ELAPSED_BLOCKS / 10).toFixed(0) + "s @ 100ms/block)");
  console.log(" Whale cap            :", (Number(MAX_STAKE_BPS) / 100).toFixed(0) + "%");
  console.log(" Min pool / players   :", ethers.formatEther(MIN_POOL), "ETH /", MIN_PARTICIPANTS.toString());
  console.log(" Keeper reward        :", (Number(KEEPER_REWARD_BPS) / 100).toFixed(0) + "% of the rake");
  console.log("\n Test accounts (alice #2, bob #3, carol #4) each hold 10000 ETH by default (hardhat node).");
  console.log("\n--- paste into public/arcade/crash.html's CONFIG, or your wallet ---");
  console.log(" CRASH_ADDRESS =", `"${crashAddr}"`);
  console.log(" AVATAR_NFT_ADDRESS =", `"${nftAddr}"`);
  console.log("\n Real RobinWood avatars minted (local mock, real collection art):");
  for (const a of AVATARS) console.log("  #" + a.id, a.name.padEnd(14), "->", a.holder.address);
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

/**
 * LOCAL-ONLY PlankCrash dev stack. Deploys PlankCrash to a running Hardhat
 * node with fast, playable round timings and funds a few test accounts so
 * the arcade page can be exercised end-to-end without any mainnet.
 *
 * Usage (two terminals):
 *   1)  npx hardhat node
 *   2)  npx hardhat run scripts/local-crash-setup.ts --network localhost
 *
 * Then open public/arcade/crash.html (see console output for the printed
 * address) and import test account key(s) into your wallet, or drive it
 * with the printed keys directly via ethers in a browser console.
 */
import hardhat from "hardhat";
const { ethers } = await hardhat.network.create();

async function main() {
  const [deployer, treasury, alice, bob, carol] = await ethers.getSigners();

  // Fast local timings so a round is actually playable in seconds, not
  // the production cadence these constants would use on a real chain.
  // 3s was tried and empirically doesn't work for a human: there's no
  // realistic time to click LAUNCH before betting closes, so it's always
  // just the background bot alone (1 participant) -- the round voids
  // every single time (needs minParticipants=2) and never reaches LIVE
  // at all. 8s is still fast dev-test cycling but leaves real react time.
  const BETTING_SECONDS = 8;
  // Was 2 -- fine when blocks only advanced on real transactions, but the
  // heartbeat fix (evm_mine every ~1s while connected) means blocks now
  // advance on a real timer, so 2 blocks meant the LIVE phase lasted well
  // under a second: the round crashed almost the instant it locked, too
  // fast to ever see the astronaut actually ascend or the multiplier
  // actually climb. 25 blocks against a ~1 block/sec heartbeat gives a
  // real, watchable flight window.
  const REVEAL_DELAY_BLOCKS = 25;
  const REGISTRATION_WINDOW_BLOCKS = 50;
  const RAKE_BPS = 250n; // 2.5%
  const MIN_PARTICIPANTS = 2n;
  const MIN_POOL = ethers.parseEther("0.01");
  const MAX_STAKE_BPS = 6000n; // 60% -- generous for a small local test pool

  const Crash = await ethers.getContractFactory("PlankCrash");
  const crash = await Crash.deploy(
    BETTING_SECONDS,
    REVEAL_DELAY_BLOCKS,
    REGISTRATION_WINDOW_BLOCKS,
    RAKE_BPS,
    MIN_PARTICIPANTS,
    MIN_POOL,
    MAX_STAKE_BPS,
    treasury.address
  );
  await crash.waitForDeployment();
  const crashAddr = await crash.getAddress();

  // Real RobinWood collection art, real token IDs from the actual
  // on-chain collection (verified this session against the real
  // metadata CID), minted on a local mock so the avatar picker can walk
  // a wallet's real on-chain holdings (tokenOfOwnerByIndex) the same way
  // it would against the real collection -- the ownership check is real,
  // only the contract instance is local. See public/arcade/art/ for the
  // actual downloaded, chroma-key-verified images.
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
  console.log(" PlankCrash local dev stack is live on http://127.0.0.1:8545 (chainId 31337)");
  console.log("========================================================");
  console.log(" PlankCrash address :", crashAddr);
  console.log(" Treasury (acct #1) :", treasury.address);
  console.log(" Betting window     :", BETTING_SECONDS, "seconds");
  console.log(" Reveal delay       :", REVEAL_DELAY_BLOCKS, "blocks after lock");
  console.log(" Whale cap          :", (Number(MAX_STAKE_BPS) / 100).toFixed(0) + "%");
  console.log(" Min pool / players :", ethers.formatEther(MIN_POOL), "ETH /", MIN_PARTICIPANTS.toString());
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

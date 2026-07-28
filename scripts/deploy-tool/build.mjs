// Bundles ethers + WalletConnect's EthereumProvider into one browser-ready
// ESM file. The esm.sh CDN failed to transpile @walletconnect/ethereum-provider's
// deep dependency tree (uint8arrays, @walletconnect/relay-auth internals) —
// confirmed by hand, not assumed — so this vendors it locally instead.
import { build } from "esbuild";

await build({
  entryPoints: ["entry.js"],
  bundle: true,
  format: "esm",
  outfile: "wallet-bundle.js",
  platform: "browser",
  target: "es2020",
  define: { "process.env.NODE_ENV": '"production"' },
  // WalletConnect's tree assumes a couple of Node globals exist; the browser
  // build doesn't need real crypto randomness beyond what browsers already
  // expose via globalThis.crypto, so empty shims are enough to satisfy imports.
  inject: [],
  logLevel: "info",
});
console.log("Built ./wallet-bundle.js");

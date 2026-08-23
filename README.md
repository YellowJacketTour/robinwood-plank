# PlankSpace single-wallet fix

Apply these files to the `plankspace-test` branch only.

1. Replace `integrations/plankspace-app/app/plank-love-wallet.ts` with the included file.
2. Copy the changes from the repository diff for `lib/wallet-context.tsx` and `components/ConnectWalletModalReown.tsx`.
3. Build with `npm run build`, then commit and push `HEAD:plankspace-test`.

This removes the obsolete iframe/postMessage bridge. PlankSpace now asks the root Plank.love WalletProvider to connect, switch chain, and sign. Reown stays mounted so the existing mobile WalletConnect session can restore after navigation or reload. No code calls `window.ethereum`, so MetaMask is not selected as a fallback.

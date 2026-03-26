# Solana Transfer Console

Static browser app for moving selected SOL and SPL token balances from a connected Solana wallet to a destination wallet you control.

## What it does

- Detects common injected Solana wallets in the browser, including Phantom, Backpack, and Solflare
- Can support WalletConnect QR for compatible mobile wallets if you add a project ID in code
- Reads the connected wallet's SOL balance and parsed SPL token accounts
- Uses a fixed destination wallet configured in code
- Lets you explicitly choose assets with `Max` buttons before building a transfer plan
- Shows a review section with destination, selected assets, and fee estimate before signing
- Transfers only the selected assets, while reserving SOL for estimated fees

## How to run

Serve the folder with any static server. Example:

```powershell
npx serve .
```

Then open the local URL in a browser that has a Solana wallet extension installed.

If you want QR/mobile wallet support:

1. Create a WalletConnect project ID.
2. Add it to `WALLETCONNECT_PROJECT_ID` in [app.js](c:/Users/White/Desktop/SolanaTransfer/app.js).
3. Reload the app and use the `Connect wallet` button.

## Notes

- The app is client-side only. Transaction signing stays inside the connected wallet.
- `mainnet-beta` is the default network. Switch to `devnet` first if you want a safe test pass.
- The app transfers fungible SPL token balances. It does not yet handle NFTs, compressed assets, stake accounts, or special token extensions.
- MetaMask and other non-native Solana wallets only work if they expose a Solana-compatible connector to the page. Plain `window.ethereum` injection is not enough for Solana signing.
- Token accounts are only included when you explicitly select them in the UI.
- The page shows one `Connect wallet` button. Browser wallets work without extra UI configuration.
- The destination wallet is fixed in `DESTINATION_WALLET` in [app.js](c:/Users/White/Desktop/SolanaTransfer/app.js).

# Chrome Web Store: what each field says

Texts for the developer dashboard, field by field. Keep them true to what the code does: a reviewer checks.

## Store listing

- **Name:** Otus Wallet (from the manifest)
- **Summary** (132 characters at most): A Solana wallet that shows what every transaction does before you sign, and guards your accounts while it lands.
- **Category:** Productivity
- **Language:** English
- **Description:**

  Otus is a self-custodial Solana wallet. Your keys stay on your device, sealed with your password, and never leave it.

  Every transaction a site asks you to sign is simulated first and explained: what leaves your accounts and where it goes, what each program does, and whether anything takes control of an account of yours. Otus flags drains, look-alike sites, unknown programs and authority changes, and says plainly what it found.

  When you alone sign, Otus adds guards (Lighthouse assertions) that make the transaction fail onchain if your accounts would end up worse than what you reviewed.

  - Create or import a wallet (recovery phrase or private key), or watch an address.
  - Send SOL and tokens, with checks on the address you type.
  - Connect to Solana sites through the Wallet Standard.
  - Use your own RPC endpoint.

- **Icon:** icons/icon-128.png
- **Screenshots** (1280×800 or 640×400, at least one): the lobby, a review's three steps, Send.

## Privacy practices

- **Single purpose:** A self-custodial Solana wallet: it keeps the user's keys on their device, shows what each transaction a site asks for would do, and signs only what the user approves.
- **Permission justifications:**
  - `storage`: keeps the encrypted vault (the user's keys, sealed with their password), their accounts, connected sites and settings on this device.
  - `alarms`: locks the wallet after the time the user chose.
  - Content scripts on `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`: make the wallet available to Solana sites through the Wallet Standard, so a site can ask to connect or to sign; every request opens Otus's own window, where the user reviews and approves it. Localhost is for developers testing their own apps.
- **Remote code:** No, I am not using remote code.
- **Data usage** (check these, and certify the three statements):
  - Financial and payment information: wallet addresses and transactions are sent to the Solana RPC endpoint the user sets, to read balances, simulate and send transactions; token mint addresses are sent to Jupiter's token API for names, icons and prices.
  - Authentication information: the password and keys are handled on the device only, encrypted, and never sent anywhere.
- **Privacy policy URL:** a public page with the text of store/privacy.md.

## Test instructions

Install, then in the setup tab create a wallet with any password. In Settings, set a Solana RPC URL (devnet works: https://api.devnet.solana.com). Then open https://anza-xyz.github.io/wallet-adapter/example/ , pick Otus, connect, and try Sign Message or a transaction: each opens Otus's review window.

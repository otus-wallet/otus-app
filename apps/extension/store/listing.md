# Chrome Web Store: what each field says

Texts for the developer dashboard, field by field, taken from the site (otus.sh) so both say the same. Keep them true to
what the code does: a reviewer checks. Visible text names no other protocol or product; screenshots may.

## Store listing

- **Name:** Otus Wallet (from the manifest)
- **Summary** (132 characters at most): The Solana wallet that shows you exactly what a transaction carries, and holds your accounts onchain to what you reviewed.
- **Category:** Tools
- **Language:** English
- **Description:**

  Otus is a self-custodial Solana wallet that shows you exactly what a transaction carries. Every balance it moves, every program it calls, everything it adds. No "just trust us".

  Every request opens in three steps. Read as much or as little as you want, then decide.
  - Balances: every balance of yours that changes, and what a proposal you vote on would do with its vault.
  - Programs: each program and instruction in plain words, and everything Otus adds to it.
  - Verdict: a verdict with its reasons. Never a blind "approve".

  Onchain guards lock in what you reviewed. When you sign, Otus adds onchain checks that hold your accounts to what you reviewed. If a transaction would leave you with less, it fails onchain and nothing moves. Everything Otus adds is listed in the review, under its own name.

  No explorer needed. Every transaction of yours, read in plain words, right in the wallet: every balance it moved, the fee and who paid it, its memo and programs, and dust from look-alike addresses flagged.

  Simple where it can be:
  - Keys sealed on your device (AES-256-GCM, password through Argon2id), or on a Ledger.
  - Send, receive and stake SOL.
  - Warns when an address only looks like one you know.
  - Works with any Solana app, on Mainnet, Devnet or your own RPC.

  Open source. Read it, build it, compare it with what you installed.

- **Icon:** assets/icons/icon-128.png
- **Screenshots** (1280×800, made by otus-lab's `chrome/shot-store.mjs`): images/screenshot-1-review.png to
  screenshot-5-wallet.png, in order.
- **Small promo tile** (440×280): images/promo-small.png

## Privacy practices

- **Single purpose:** A self-custodial Solana wallet: it keeps the user's keys on their device, shows what each transaction a site asks for would do, and signs only what the user approves.
- **Permission justifications:**
  - `storage`: keeps the encrypted vault (the user's keys, sealed with their password), their accounts, connected sites and settings on this device.
  - `alarms`: locks the wallet after the time the user chose.
  - Content scripts on `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`: make the wallet available to Solana sites through the Wallet Standard, so a site can ask to connect or to sign; every request opens Otus's own window, where the user reviews and approves it. Localhost is for developers testing their own apps.
- **Remote code:** No, I am not using remote code.
- **Data usage** (check these, and certify the three statements):
  - Financial and payment information: wallet addresses and transactions go to the Solana RPC endpoint in use (Otus's relay by default, or one the user sets) to read balances and activity, simulate and send transactions; token mint addresses go to Jupiter's token API for names, icons and prices.
  - Location: Otus's relay sees the IP address of each call and counts calls per address, in memory only, to stop abuse.
  - Authentication information is not checked: the password and keys stay on the device, encrypted, and are never sent.
- **Privacy policy URL:** https://otus.sh/privacy

## Test instructions

Install, then in the setup tab create a wallet with any password. Mainnet works with no setup; to test without funds, set Settings → Network to Devnet. Then open https://anza-xyz.github.io/wallet-adapter/example/ , pick Otus, connect, and try Sign Message or a transaction: each opens Otus's review window.

# Otus Wallet privacy policy

Otus Wallet ("Otus") is a self-custodial Solana wallet for Chrome. This policy says what Otus does with your data.

**Your keys and password stay on your device.** Your recovery phrases and private keys are kept in the browser's extension storage, encrypted with AES-256-GCM under a key sealed with your password through Argon2id. Your password is never stored. None of this is ever sent anywhere.

**What Otus keeps on your device:** your accounts' addresses and names, the sites you connected and the account each sees, the addresses you keep, how many transfers you made to each, and your settings (including the RPC address you set). It stays in your browser's storage until you remove it or uninstall Otus.

**What Otus sends, and to whom:**

- To the Solana RPC endpoint you set (or Otus's default, when there is one): the addresses and transactions needed to show your balances, simulate a transaction before you sign it, and send the transactions you approve. Sent transactions are public on the Solana blockchain, as on any wallet.
- To Jupiter's token API (lite-api.jup.ag): the token mint addresses Otus needs names, icons and prices for.
- To the sites you connect: your wallet's address, and the signatures you approve.

Otus sends nothing to its developers. It has no analytics, no tracking, no ads, and sells no data.

**Changes.** If this policy changes, the new one is published here with its date.

**Contact:** through the developer contact on Otus's Chrome Web Store page.

Last updated: October 5, 2026

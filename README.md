# Otus Wallet

A self-custodial Solana wallet for Chrome, on `@solana/kit`. Every transaction is simulated and
explained before you sign it, and guarded so it can do no more than it showed.

- Keys sealed in the extension (AES-256-GCM, password through Argon2id), or on a Ledger.
- Each review: balance changes, programs in words, a verdict.
- Lighthouse guards hold what the review showed.
- Wallet Standard, Squads v4, Activity per wallet.

## Build

    npm ci
    npm run build      # or: npm run watch

In `chrome://extensions`: Developer mode, "Load unpacked", pick `dist`. Then set your Helius RPC
in Settings.

## Test

    npm test
    npm run typecheck

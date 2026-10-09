# Otus Wallet

A self-custodial, open-source Solana wallet that shows you exactly what you're signing, and lets you check
it in as much detail as you want.

- Guards on your transactions: if one tries to take more than the review showed, it fails.
- Simulated before you sign: every balance of yours that changes, and by how much.
- Every program and instruction in plain words; unknown programs and token approvals called out.
- A clear verdict: Looks safe, Caution or Not safe, with the reasons.
- Keys sealed on your device (AES-256-GCM, password through Argon2id), or on a Ledger.
- Works with any Solana app through Wallet Standard.

The review, the guards and the decoders are [@otus-wallet/sdk](https://github.com/otus-wallet/otus-sdk), usable on
their own.

## Build

Until the SDK is on npm, clone it next to this repo:

    git clone https://github.com/otus-wallet/otus-sdk ../otus-sdk
    (cd ../otus-sdk && npm ci && npm run build)
    npm ci
    npm run build      # or: npm run watch

In `chrome://extensions`: Developer mode, "Load unpacked", pick `apps/extension/dist`.

## Test

    npm test
    npm run typecheck

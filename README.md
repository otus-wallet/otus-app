# Otus Wallet

A self-custodial, open-source Solana wallet that shows you exactly what you're signing, and lets you check
it in as much detail as you want.

- Guards on your transactions: if one tries to take more than the review showed, it fails.
- Simulated before you sign: every balance of yours that changes, and by how much.
- Every program and instruction in plain words; unknown programs and token approvals called out.
- A clear verdict: Looks safe, Caution or Not safe, with the reasons.
- Keys sealed on your device (AES-256-GCM, password through Argon2id), or on a Ledger.
- Works with any Solana app through Wallet Standard.

## Build

    npm ci
    npm run build      # or: npm run watch

In `chrome://extensions`: Developer mode, "Load unpacked", pick `dist`. A build from source has its own
extension ID, which Otus's RPC doesn't serve: set your own RPC in Settings (a Helius one for Activity).

## Test

    npm test
    npm run typecheck

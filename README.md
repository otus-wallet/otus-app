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

## Layout

- `packages/core`: the logic every app shares: what Otus keeps, builds and says. No platform's API.
- `packages/ui`: the screens, in React, the same everywhere; each app gives them its platform (`core/src/platform.ts`).
- `packages/provider`: Otus as sites see it, through Wallet Standard.
- `apps/extension`: the Chrome extension: its background, keystore and review of sites' requests.

## Build

Until the SDK is on npm, clone it next to this repo:

    git clone https://github.com/otus-wallet/otus-sdk ../otus-sdk
    (cd ../otus-sdk && npm ci && npm run build)
    npm ci
    npm run build      # or: npm run watch

In `chrome://extensions`: Developer mode, "Load unpacked", pick `apps/extension/dist`.
The release zip (`npm run package`) is the store's build: loaded unpacked, it gets an extension ID Otus's RPC
doesn't serve, so set your own RPC in Settings (a Helius one for Activity).

## Verify

The Otus you installed can be checked against this code: build the release's tag and compare.

    git checkout vX.Y.Z    # the version chrome://extensions shows for Otus
    (cd ../otus-sdk && git checkout <the commit in the release notes> && npm ci && npm run build)
    npm ci
    npm run verify -- <path>

`<path>` is the release's `otus.zip`, the store's `.crx`, or the folder Chrome installed Otus in: the Profile Path that
`chrome://version` shows, then `Extensions/gciljmcmgcigmoakpmdcbefjabcnhekl/X.Y.Z_0`. It says THE SAME when every file
matches, byte for byte. Left out is only what the store adds: its signature of the files (`_metadata/`) and the
manifest's `key` and `update_url`. With the same `zip`, `npm run package` gives the release's `otus.zip` byte for byte
too. Releases up to v0.2.0 carry the time they were built, and can't be matched.

## Test

    npm test
    npm run typecheck

// The keystore's calls and answers: what Otus's pages may ask it, wherever it runs (the background in Chrome).
/** What Otus's own pages ask the keystore. Sites never reach it. */
export type KeysCall =
    | { keys: 'status' }
    | { keys: 'unlock'; password: string }
    | { keys: 'lock' }
    | { keys: 'phrase'; words: 12 | 24 } // the new phrase on show, the same until it is added, so what the user wrote down is what gets saved
    | { keys: 'add'; from: { phrase: string } | { privateKey: string }; label: string; newPassword?: string } // newPassword: the first, when there is no vault yet; later ones need Otus unlocked
    | { keys: 'derive'; label: string } // the next account on your phrase
    | { keys: 'reveal'; account: string; what: 'key' | 'phrase'; password: string } // an account's private key, or its phrase
    | { keys: 'password'; password: string; newPassword: string } // the vault sealed again, under a new key, for a new password
    | { keys: 'seal'; newPassword: string }; // the first password, before any phrase or key: for a Ledger, or an address watched

export type KeysReply = { ok: true; result: unknown } | { ok: false; error: string };
export type KeyStatus = { vault: boolean; unlocked: boolean };

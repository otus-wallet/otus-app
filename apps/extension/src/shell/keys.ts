// The keystore as the background runs it. The vault sits in local storage; while unlocked, its key sits in session
// storage, which the browser keeps in memory and drops when it closes. Keys are made for one signature and let go.
import { createKeyPairFromPrivateKeyBytes, getAddressEncoder, getAddressFromPublicKey, getBase58Decoder, signBytes, type Address, type SignatureBytes } from '@solana/kit';

import { newPhrase, phraseOf, privateKeyFromText, privateKeyOf, privateKeysOf } from '../keys/derive.ts';
import { base64, bytes, createVault, openVault, readSecrets, UnknownVault, writeSecrets, WrongPassword, type Bytes, type Secret, type Vault } from '../keys/vault.ts';
import { NO_KEY, Refused } from '@otus-wallet/core/protocol.ts';
import type { KeysCall, KeysReply, KeyStatus } from '@otus-wallet/core/keystore.ts';
import { load, named, signs, update, type Account } from '@otus-wallet/core/state.ts';

export const LOCK_ALARM = 'lock'; // the background sets it from how long Otus has been closed
const MIN_PASSWORD = 8;

const stored = async () => ((await chrome.storage.local.get('vault')).vault as Vault | undefined) ?? null;
const held = async (): Promise<Bytes | null> => {
    const { unlocked } = await chrome.storage.session.get('unlocked');
    return typeof unlocked === 'string' ? bytes(unlocked) : null;
};

// One keystore call at a time: two pages adding at once would each write back the vault without the other's secret,
// and a lock during a signature or an import must not be undone by it.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
}

/** A call from Otus's pages → the reply. Never throws. What failed is logged by its kind only: a message may quote what
 *  was asked, a phrase or a key among it. */
export async function keysCall(call: KeysCall): Promise<KeysReply> {
    try {
        return { ok: true, result: await serial(() => run(call)) };
    } catch (e) {
        if (e instanceof Refused) return { ok: false, error: e.message };
        console.error('Otus: keys', e instanceof Error ? e.name : typeof e);
        return { ok: false, error: 'Otus could not do that' };
    }
}

async function run(call: KeysCall): Promise<unknown> {
    switch (call.keys) {
        case 'status':
            return { vault: (await stored()) !== null, unlocked: (await held()) !== null } satisfies KeyStatus;
        case 'unlock': {
            const key = await opened(text(call.password));
            await keep(key);
            return void (await verified(key).catch((e) => console.error('Otus: checking accounts', e)));
        }
        case 'lock':
            return locking();
        case 'phrase':
            if (await shielded()) throw new Refused('Unlock Otus first');
            return pending(call.words === 24 ? 24 : 12);
        case 'add':
            return add(source(call.from), label(call.label), call.newPassword === undefined ? undefined : text(call.newPassword));
        case 'derive':
            return derive(label(call.label));
        case 'reveal':
            return reveal(text(call.account), call.what === 'phrase' ? 'phrase' : 'key', text(call.password));
    }
    throw new Refused('unknown call');
}

export const lock = () => serial(locking);

async function locking() {
    await chrome.storage.session.remove('unlocked');
    await chrome.alarms.clear(LOCK_ALARM);
}

export const locked = async () => (await held()) === null;

/** Whether Otus's pages show only its lock: a vault exists, and its key is not held. Then nothing but unlocking, the
 *  status and saying no goes through, whatever a page asks. */
export const shielded = async () => (await stored()) !== null && (await held()) === null;

/** The account's signature of these bytes. Throws Refused when locked or when Otus holds no key for it. */
export const sign = (account: Account, data: Uint8Array): Promise<SignatureBytes> =>
    serial(async () => {
        const key = await held();
        if (!key) throw new Refused('Otus is locked');
        const vault = await stored();
        const secret = vault && account.key ? (await readSecrets(vault, key)).find((s) => s.id === account.key!.secret) : undefined;
        if (!secret) throw new Refused(NO_KEY);
        const pair = await keyPair(secret, account.key!.index);
        if ((await getAddressFromPublicKey(pair.publicKey)) !== account.address) throw new Refused(NO_KEY);
        return signBytes(pair.privateKey, data);
    });

// The vault's key, from the password. Throws Refused.
async function opened(password: string): Promise<Bytes> {
    const vault = await stored();
    if (!vault) throw new Refused('There is no wallet to unlock');
    return openVault(vault, password).catch((e) => {
        if (e instanceof UnknownVault) throw new Refused("Otus can't open its vault: it was changed outside Otus");
        throw e instanceof WrongPassword ? new Refused('Wrong password') : e;
    });
}

// Unlocked until the background locks it, or the browser closes.
const keep = (key: Bytes) => chrome.storage.session.set({ unlocked: base64(key) });

// The phrases being created wait in session storage, one of each length, until one is added: switched from 12 words to
// 24 and back, it is the 12 shown before, which may be written down already.
async function pending(words: 12 | 24): Promise<string> {
    const kept = await waiting();
    if (kept[words]?.split(' ').length === words) return kept[words];
    const phrase = newPhrase(words);
    await chrome.storage.session.set({ pending: { ...kept, [words]: phrase } });
    return phrase;
}

// The phrases being created, by length.
async function waiting(): Promise<Partial<Record<12 | 24, string>>> {
    const { pending } = await chrome.storage.session.get('pending');
    if (typeof pending !== 'object' || pending === null) return {};
    return Object.fromEntries(([12, 24] as const).flatMap((n) => (typeof (pending as Record<number, unknown>)[n] === 'string' ? [[n, (pending as Record<number, string>)[n]]] : [])));
}

// A key pair that cannot be exported, for one use.
async function keyPair(secret: Secret, index: number | undefined): Promise<CryptoKeyPair> {
    const privateKey = 'phrase' in secret ? await privateKeyOf(secret.phrase, index ?? 0) : bytes(secret.key);
    try {
        return await createKeyPairFromPrivateKeyBytes(privateKey, false);
    } finally {
        privateKey.fill(0);
    }
}

const addressOf = async (secret: Secret, index: number | undefined) => getAddressFromPublicKey((await keyPair(secret, index)).publicKey);

// A phrase (its first account) or a private key → an account of yours. The first one creates the vault with a new
// password; any later one needs Otus unlocked, as the page asking shows only then, and a new password for it is
// refused (a page left from before the vault existed).
async function add(from: { phrase: string } | { privateKey: string }, name: string, newPassword: string | undefined): Promise<Account> {
    const id = crypto.randomUUID();
    let fresh: Secret;
    if ('phrase' in from) {
        fresh = { id, phrase: phraseOf(text(from.phrase)) ?? refuse('Those words are not a valid recovery phrase') };
    } else {
        const key = (await privateKeyFromText(text(from.privateKey))) ?? refuse('That is not a private key: paste the whole key your wallet exports');
        fresh = { id, key: base64(key) };
        key.fill(0);
    }
    const index = 'phrase' in fresh ? 0 : undefined;
    const address = await addressOf(fresh, index);

    let vault = await stored();
    let key: Bytes;
    let secrets: Secret[] = [];
    if (!vault) {
        if (newPassword === undefined || newPassword.length < MIN_PASSWORD) throw new Refused(`Use a password of ${MIN_PASSWORD} characters or more`);
        ({ vault, key } = await createVault(newPassword, []));
    } else {
        if (newPassword !== undefined) throw new Refused('Otus has a password already: reload this page');
        key = (await held()) ?? refuse('Unlock Otus first');
        secrets = await readSecrets(vault, key);
    }
    const same = secrets.find((s) => ('phrase' in s && 'phrase' in fresh ? s.phrase === fresh.phrase : 'key' in s && 'key' in fresh && s.key === fresh.key));
    // An account held already is refused, unless what comes is its phrase while Otus only had its key: then the
    // phrase is kept and the account moves onto it, so New account reaches the phrase's other accounts.
    const existing = (await load()).accounts.find((a) => a.address === address && a.key);
    if (existing && (same || !('phrase' in fresh))) {
        // A phrase imported again that Otus has: the accounts you removed from it may come back with New account.
        if ('phrase' in fresh) await unremoved(fresh.phrase);
        throw new Refused('phrase' in fresh ? 'That phrase is in Otus already: New account brings back the accounts you removed from it' : 'That account is in Otus already');
    }
    // The vault with its secret and the account on it, written at once: an add cut short leaves neither.
    const sealed = same ? {} : { vault: await writeSecrets(vault, key, [...secrets, fresh]) };
    const account = await list({ address, label: name, key: { secret: (same ?? fresh).id, ...(index !== undefined && { index }) } }, sealed);
    await keep(key);
    if ('phrase' in fresh && Object.values(await waiting()).includes(fresh.phrase)) await chrome.storage.session.remove('pending');
    if ('phrase' in fresh) await unremoved(fresh.phrase);
    return account;
}

// What an add comes from: a phrase, or a private key, as text.
function source(v: unknown): { phrase: string } | { privateKey: string } {
    if (typeof v !== 'object' || v === null) throw new Refused('bad input');
    if ('phrase' in v) return { phrase: text(v.phrase) };
    if ('privateKey' in v) return { privateKey: text(v.privateKey) };
    throw new Refused('bad input');
}

// An account's private key as wallets export it (base58 of the key and its public key), or the phrase it comes from.
// Always with the password, unlocked or not; the key is checked against the account before it is shown.
async function reveal(address: string, what: 'key' | 'phrase', password: string): Promise<string> {
    const key = await opened(password);
    const vault = (await stored())!;
    const account = (await load()).accounts.find((a) => a.address === address);
    const secret = account?.key ? (await readSecrets(vault, key)).find((s) => s.id === account.key!.secret) : undefined;
    if (!account || !secret) throw new Refused(NO_KEY);
    if (what === 'phrase') return 'phrase' in secret ? secret.phrase : refuse('This account came from a private key: it has no phrase');
    const privateKey = 'phrase' in secret ? await privateKeyOf(secret.phrase, account.key!.index ?? 0) : bytes(secret.key);
    try {
        const pair = await createKeyPairFromPrivateKeyBytes(privateKey, false);
        if ((await getAddressFromPublicKey(pair.publicKey)) !== account.address) throw new Refused(NO_KEY);
        return getBase58Decoder().decode(new Uint8Array([...privateKey, ...getAddressEncoder().encode(account.address)]));
    } finally {
        privateKey.fill(0);
    }
}

// The next account on your phrase: the one of the account in use, or the only phrase you have accounts on. Skips the
// ones you have, and the ones you removed.
async function derive(name: string): Promise<Account> {
    const key = (await held()) ?? refuse('Unlock Otus first');
    const vault = (await stored()) ?? refuse('There is no recovery phrase in Otus');
    const { accounts, active, removed } = await load();
    const phrases = (await readSecrets(vault, key)).filter((s) => 'phrase' in s && accounts.some((a) => a.key?.secret === s.id));
    const current = accounts.find((a) => a.address === active)?.key?.secret;
    const phrase = phrases.find((s) => s.id === current) ?? (phrases.length === 1 ? phrases[0] : refuse(phrases.length ? 'Use a wallet of the phrase you want a new account on, then try again' : 'There is no recovery phrase in Otus'));
    const taken = new Set(accounts.filter((a) => a.key?.secret === phrase.id).map((a) => a.key!.index));
    for (let index = 0; ; index++) {
        if (taken.has(index)) continue;
        const address = await addressOf(phrase, index);
        if (!removed.includes(address)) return list({ address, label: name, key: { secret: phrase.id, index } });
    }
}

// A phrase imported again: its accounts you once removed (the first twenty) may come back with New account.
async function unremoved(phrase: string) {
    if ((await load()).removed.length === 0) return;
    const keys = await privateKeysOf(phrase, 20);
    const addresses = new Set<string>();
    for (const k of keys) {
        try {
            addresses.add(await getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(k, false)).publicKey));
        } finally {
            k.fill(0);
        }
    }
    await update((s) => ({ removed: s.removed.filter((a) => !addresses.has(a)) }));
}

/** Drops from the vault the phrases and keys no account of yours uses any more, once a wallet is removed: it is gone
 *  from Otus. Only then: an account list that lost entries some other way (cut short, changed outside Otus) must not
 *  take secrets with it. */
export const prune = () => serial(pruned);
async function pruned() {
    const [key, vault] = [await held(), await stored()];
    if (!key || !vault) return;
    const { accounts } = await load();
    const secrets = await readSecrets(vault, key);
    const used = secrets.filter((s) => accounts.some((a) => a.key?.secret === s.id));
    if (used.length < secrets.length) await chrome.storage.local.set({ vault: await writeSecrets(vault, key, used) });
}

// Each account of yours as its key in the vault gives it: an address written into storage by anything but Otus (as
// malware may, while Chrome is closed) is put back, so Receive never shows someone else's under your wallet's name.
// One whose key the vault does not hold keeps its address as one Otus only watches; one that comes back to an address
// another account has already goes. A key that gives no address at all stops the check: nothing is changed then.
async function verified(key: Bytes) {
    const secrets = new Map((await readSecrets((await stored())!, key)).map((s) => [s.id, s]));
    const fixed = new Map<string, Address | null>();
    for (const a of (await load()).accounts) {
        if (!a.key) continue;
        const secret = secrets.get(a.key.secret);
        const real = secret ? await addressOf(secret, a.key.index) : null;
        if (real !== a.address) fixed.set(a.address, real);
    }
    if (fixed.size === 0) return;
    console.error('Otus: an account of yours was changed outside Otus and is put back');
    await update((s) => {
        const kept = new Set(s.accounts.filter((a) => !fixed.has(a.address)).map((a) => a.address));
        const accounts = s.accounts.flatMap((a): Account[] => {
            if (!fixed.has(a.address)) return [a];
            const real = fixed.get(a.address)!;
            if (real === null) return [{ address: a.address, label: a.label }]; // no key Otus holds is its
            if (kept.has(real)) return [];
            kept.add(real);
            return [{ ...a, address: real }];
        });
        const active = s.active && fixed.has(s.active) ? (fixed.get(s.active) ?? s.active) : s.active;
        return { accounts, active: accounts.some((a) => a.address === active) ? active : (accounts[0]?.address ?? null) };
    });
}

// Added to your accounts and put in use, with `also` written in the same write. An address you only watched becomes
// one you can sign for, keeping its name.
async function list(account: Account, also: Record<string, unknown> = {}): Promise<Account> {
    let listed = account;
    await update(({ accounts, contacts }) => {
        const known = accounts.find((a) => a.address === account.address);
        // When Otus came to sign for it: kept for one it signed for already (moved onto its phrase), now for any other.
        const since = known && signs(known) ? known.since : Math.floor(Date.now() / 1000);
        listed = { ...account, ...(known && { label: known.label }), ...(since !== undefined && { since }) };
        const kept = contacts.filter((c) => c.address !== account.address); // yours now: no longer an address you keep
        return { accounts: known ? accounts.map((a) => (a === known ? listed : a)) : [...accounts, listed], active: account.address, contacts: kept };
    }, also);
    return listed;
}

function text(v: unknown): string {
    if (typeof v !== 'string' || v.length > 1024) throw new Refused('bad input');
    return v;
}

const label = (v: unknown) => named(text(v)) || 'Account';

function refuse(why: string): never {
    throw new Refused(why);
}

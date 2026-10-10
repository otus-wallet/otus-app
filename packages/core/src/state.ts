import { isAddress, type Address } from '@solana/kit';

import { alike } from '@otus-wallet/sdk/format';

import { pathBytes } from './ledger/solana.ts';
import type { Outside } from './outside.ts';
import { platform } from './platform.ts';
import { DEFAULT_SETTINGS, settingsOf, type Settings } from './settings.ts';

/** An account Otus shows. `key`: where the vault keeps its key (a secret, and the account's index on a phrase).
 *  `ledger`: its key is on a Ledger, at this derivation path. None for an address you only watch. */
export type Account = {
    address: Address;
    label: string;
    key?: { secret: string; index?: number };
    ledger?: { path: string };
    signatures?: number; // made with Otus
    since?: number; // when Otus came to sign for it, in seconds since 1970; none for one it signed for before keeping this
};

/** Whether the account can sign: with its key in the vault, or on its Ledger. */
export const signs = (a: Account) => Boolean(a.key || a.ledger);

/** Whether the account signs on a device, in the approval window: a Ledger. */
export const onDevice = (a: Account) => Boolean(a.ledger);

/** A site the user connected, the account it sees, how many requests the user signed for it, when the first
 *  transaction (seconds since 1970), and the programs its transactions called (Solana's own aside), to tell one it never
 *  did; none kept for a site signed for before Otus kept them. */
export type Site = { account: Address; signatures: number; since?: number; programs?: Address[] };

/** A transaction signed for a site on a durable nonce, which can run until that nonce moves on: the account that signed
 *  it, the nonce account and nonce it waits on, the site, and when (seconds since 1970). */
export type Signed = { wallet: Address; account: Address; nonce: string; host: string; at: number };

/** A delegate a site's transaction gave on a token account of yours: to whom, which site asked, and when (seconds). */
export type Given = { account: Address; to: Address; host: string; at: number };

/** An address you know, by the name you gave it: one to send to. */
export type Contact = { address: Address; label: string };

/** What Otus keeps in local storage, one key each, so a write never clobbers another part. `sent`: how
 *  many transfers made in Otus landed at each address; `removed`: accounts on a phrase that you removed, which New
 *  account never brings back; `waiting` and `given`: what sites were signed for that others can still use, the latest
 *  last; `signedHere`: the transactions' signatures Otus made with each account, the latest last; `outside`: what the
 *  popup checked of each one's activity for those signed elsewhere, by network (outsideKey), the popup's alone. */
export type State = {
    accounts: Account[];
    active: Address | null;
    sites: Record<string, Site>;
    contacts: Contact[];
    sent: Record<string, number>;
    removed: Address[];
    waiting: Signed[];
    given: Given[];
    signedHere: Record<string, string[]>;
    outside: Record<string, Outside>;
    settings: Settings;
};

const DEFAULTS: State = { accounts: [], active: null, sites: {}, contacts: [], sent: {}, removed: [], waiting: [], given: [], signedHere: {}, outside: {}, settings: DEFAULT_SETTINGS };
/** Signatures kept an account: far more than it makes between two looks at its activity. */
export const MAX_SIGNED_HERE = 200;
const MAX_CONTACTS = 200;

export async function load(): Promise<State> {
    const state = (await platform.storage.local.get(DEFAULTS)) as State;
    return { ...state, settings: settingsOf(state.settings) }; // settings saved before a newer one existed
}
export const save = (part: Partial<State>) => platform.storage.local.set(part);

// Changes to accounts and sites, one after another, each made from the state as it is then, so that two never undo
// each other. Only the background writes them: Otus's pages ask it to, with an Edit.
let queue: Promise<unknown> = Promise.resolve();
export function update(change: (state: State) => Partial<State> | null): Promise<void> {
    const run = queue.then(async () => {
        const part = change(await load());
        if (part) await save(part);
    });
    queue = run.catch(() => {});
    return run;
}

/** What Otus's pages may change in accounts, sites and the addresses you know. Settings are the popup's alone, and
 *  it writes them itself. */
export type Edit =
    | { edit: 'rename'; address: string; label: string }
    | { edit: 'remove'; address: string }
    | { edit: 'use'; address: string }
    | { edit: 'order'; addresses: string[] }
    | { edit: 'disconnect'; origin: string }
    | { edit: 'watch'; address: string; label: string }
    | { edit: 'ledger'; address: string; path: string; label: string } // an account on your Ledger, as the device gave it
    | { edit: 'keep'; address: string; label: string } // an address you know, kept by your name for it, or renamed
    | { edit: 'drop'; address: string };

/** A name as typed, as text that shows: without control, format, separator or invisible characters (fillers that
 *  draw nothing included), its compatibility forms folded, spaces collapsed, at most 32 characters; empty when no
 *  letter, digit or symbol is left. */
export function named(v: unknown): string {
    if (typeof v !== 'string') return '';
    const shown = v.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/gu, '').replace(/\s+/g, ' ').trim();
    return /[\p{L}\p{N}\p{S}]/u.test(shown) ? [...shown].slice(0, 32).join('').trim() : '';
}

/** Whether one of your accounts, or an address you keep other than `except`, goes by this name already. */
export const nameTaken = (state: State, name: string, except?: string) =>
    [...state.accounts, ...state.contacts].some((k) => k.address !== except && k.label.normalize('NFKC').toLowerCase() === name.normalize('NFKC').toLowerCase());

/** The first "Account N" no account or kept address goes by. */
export function freeName(state: State): string {
    for (let n = state.accounts.length + 1; ; n++) if (!nameTaken(state, `Account ${n}`)) return `Account ${n}`;
}

/** An edit, checked, as the change it makes; null for one that changes nothing or makes no sense. `now`: ms, when an
 *  account it adds comes to sign. */
export function edited(e: Edit, state: State, now = Date.now()): Partial<State> | null {
    const has = (address: unknown) => typeof address === 'string' && state.accounts.some((a) => a.address === address);
    const label = named;
    switch (e.edit) {
        case 'rename':
            if (!has(e.address) || !label(e.label) || nameTaken(state, label(e.label), e.address)) return null;
            return { accounts: state.accounts.map((a) => (a.address === e.address ? { ...a, label: label(e.label) } : a)) };
        case 'remove': {
            if (!has(e.address)) return null;
            const gone = state.accounts.find((a) => a.address === e.address)!;
            const left = state.accounts.filter((a) => a.address !== e.address);
            const sites = Object.fromEntries(Object.entries(state.sites).filter(([, site]) => site.account !== e.address));
            const removed = gone.key?.index !== undefined && !state.removed.includes(gone.address) ? [...state.removed, gone.address] : state.removed;
            // What Otus signed with it and checked of its activity go too: added back, it starts over from then.
            const { [e.address]: _, ...signedHere } = state.signedHere;
            const outside = Object.fromEntries(Object.entries(state.outside).filter(([key]) => !key.endsWith(` ${e.address}`)));
            return { accounts: left, sites, removed, signedHere, outside, active: state.active === e.address ? (left[0]?.address ?? null) : state.active };
        }
        case 'use': {
            if (!has(e.address)) return null;
            const used = state.accounts.find((a) => a.address === e.address)!;
            // Connected sites follow the wallet in use (open ones hear it at once), as in other wallets: each then sees
            // its address. A watch-only wallet signs nothing, so they stay with the one they had.
            if (!signs(used)) return { active: used.address };
            const sites = Object.fromEntries(Object.entries(state.sites).map(([origin, site]) => [origin, { ...site, account: used.address }]));
            return { active: used.address, sites };
        }
        case 'order': {
            if (!Array.isArray(e.addresses) || !e.addresses.every((a) => typeof a === 'string')) return null;
            const ordered = [...e.addresses.flatMap((a) => state.accounts.filter((x) => x.address === a)), ...state.accounts.filter((x) => !e.addresses.includes(x.address))];
            return { accounts: [...new Set(ordered)] };
        }
        case 'disconnect': {
            if (typeof e.origin !== 'string' || !(e.origin in state.sites)) return null;
            const { [e.origin]: _, ...rest } = state.sites;
            return { sites: rest };
        }
        case 'watch': {
            // One of your accounts now: no longer one you keep. Not one that only looks like an address you know, nor
            // by a name another has: the Send picker lists it among your wallets.
            if (typeof e.address !== 'string' || !isAddress(e.address) || has(e.address) || lookalike(state, e.address)) return null;
            const name = label(e.label) || freeName(state);
            if (nameTaken(state, name, e.address)) return null;
            return { accounts: [...state.accounts, { address: e.address, label: name }], active: e.address, contacts: state.contacts.filter((c) => c.address !== e.address) };
        }
        case 'ledger': {
            // Its address and the path of its key, read from the device. One you only watched becomes it, keeping its
            // name; one Otus signs for already stays as it is. Not one that only looks like an address you know.
            if (typeof e.address !== 'string' || !isAddress(e.address) || !ledgerPath(e.path) || lookalike(state, e.address)) return null;
            const known = state.accounts.find((a) => a.address === e.address);
            if (known && signs(known)) return null;
            const name = known?.label ?? (label(e.label) || freeName(state));
            if (!known && nameTaken(state, name)) return null;
            const account: Account = { address: e.address, label: name, ledger: { path: e.path }, since: Math.floor(now / 1000) };
            const accounts = known ? state.accounts.map((a) => (a === known ? account : a)) : [...state.accounts, account];
            return { accounts, active: e.address, contacts: state.contacts.filter((c) => c.address !== e.address) };
        }
        case 'keep': {
            // Not one of your accounts, which have names already; not one that only looks like an address you know; not
            // a name another has.
            if (typeof e.address !== 'string' || !isAddress(e.address) || has(e.address) || !label(e.label)) return null;
            if (lookalike(state, e.address) || nameTaken(state, label(e.label), e.address)) return null;
            const contact = { address: e.address, label: label(e.label) };
            if (state.contacts.some((c) => c.address === e.address)) return { contacts: state.contacts.map((c) => (c.address === e.address ? contact : c)) };
            return state.contacts.length < MAX_CONTACTS ? { contacts: [...state.contacts, contact] } : null;
        }
        case 'drop':
            return state.contacts.some((c) => c.address === e.address) ? { contacts: state.contacts.filter((c) => c.address !== e.address) } : null;
    }
    return null;
}

// A derivation path as Otus keeps it: "44'/501'/0'/0'", one the Solana app takes.
function ledgerPath(path: unknown): boolean {
    if (typeof path !== 'string' || path.startsWith('m')) return false;
    try {
        return pathBytes(path).length > 0;
    } catch {
        return false;
    }
}

/** What Otus knows of an address you send to: your name for it, as one of your accounts (watched or not) or one you
 *  keep, and how many of your transfers made in Otus landed there. */
export type Acquaintance = { label: string | null; as: 'account' | 'watched' | 'contact' | null; sent: number };
export function acquaintance(state: State, address: string): Acquaintance {
    const account = state.accounts.find((a) => a.address === address);
    const contact = state.contacts.find((c) => c.address === address);
    const as = account ? (signs(account) ? 'account' : 'watched') : contact ? 'contact' : null;
    return { label: account?.label ?? contact?.label ?? null, as, sent: Object.hasOwn(state.sent, address) ? state.sent[address] : 0 };
}

/** Another known address the one given looks like: the same first and last characters, as wallets shorten addresses
 *  and address poisoners forge them, different in between. Known: your accounts, the ones you keep, the ones you sent
 *  to. Looked for even when the one given is known too, as a forged one may have been kept or sent to. */
export function lookalike(state: State, address: string): { address: string; label: string | null } | null {
    const known = [...state.accounts, ...state.contacts].map((k): { address: string; label: string | null } => ({ address: k.address, label: k.label }));
    known.push(...Object.keys(state.sent).map((a) => ({ address: a, label: null })));
    return known.find((k) => k.address !== address && alike(k.address, address)) ?? null;
}

/** A transfer made in Otus landed at this address: one more. */
export const sentTo = (state: State, address: Address): Partial<State> => ({ sent: { ...state.sent, [address]: (Object.hasOwn(state.sent, address) ? state.sent[address] : 0) + 1 } });

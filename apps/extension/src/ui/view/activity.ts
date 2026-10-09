// A wallet's transactions as Activity shows them: each in a line ("Swap 1 SOL → 120.58 USDC", "Minted 1,000 BONK", to
// whom, when), what came in and what went out told apart; opened, everything its transaction told: every balance it
// moved, the rent and the fee apart, the other side whole, its programs, memo and failure. A copy of an address, the
// kind dust is sent from, is told as one.
import type { Address } from '@solana/kit';

import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
import { LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3, MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';

import type { Activity, Move, Told } from '@otus-wallet/sdk/activity/summary';
import { LIGHTHOUSE } from '@otus-wallet/sdk/programs/addresses';
import { alike } from '../../shell/state.ts';
import { amount, cap, short, sol } from '@otus-wallet/sdk/format';
import { story, type Names } from '@otus-wallet/sdk/review/effects';
import type { Step } from '@otus-wallet/sdk/programs/squads';

export type RowIcon = 'send' | 'receive' | 'swap' | 'plus' | 'trash' | 'key' | 'refresh' | 'shield' | 'box' | 'cross' | 'bang';
export type RowTone = 'plain' | 'warn' | 'danger';
export type Detail = { text: string; tone?: 'ok' | 'warn' | 'danger' | 'dim' };
/** Words of a line, an amount among them marked as what came in or went out. */
export type Part = { text: string; way?: 'in' | 'out' };

/** One transaction, as a line and its details. `address`: the other side, shown whole; `copy`: made to look like
 *  another. */
export type Row = {
    signature: string | null;
    time: number | null;
    icon: RowIcon;
    tone: RowTone;
    title: Part[];
    sub: Part[];
    details: Detail[];
    address: { label: string; address: Address; name: string | null; copy: boolean } | null;
};

/** What the words need: a token's symbol (a verified one's, else the mint in short), a name for an address (the wallet's
 *  own address marked yours, another wallet's or a contact's name, a program's), and the addresses you know. */
export type Naming = {
    wallet: Address;
    symbol(mint: Address): string;
    who(address: Address): string;
    program(address: Address): string;
    known: Address[];
};

/** A line's words, as one text. */
export const text = (parts: Part[]) => parts.map((p) => p.text).join('');

const VERBS: Record<Step, string> = { setup: 'new multisig', create: 'create', propose: 'propose', activate: 'activate', approve: 'approve', reject: 'reject', cancel: 'cancel', execute: 'execute', spend: 'spend', close: 'close' };

/** Each transaction read → its row; one Otus could not read says so. An address like another, on the page or known, is
 *  cut short where they part, and the copy of the two told as one. */
export function rows(read: (Activity | { unreadable: string })[], n: Naming): Row[] {
    const done = read.filter((a): a is Activity => 'kind' in a);
    const copies = copiesOn(done, n.known);
    const seen = [...new Set([...n.known, ...done.flatMap((a) => (a.other ? [a.other] : []))])];
    const who = (a: Address) => {
        const named = n.who(a);
        const twin = named === short(a) ? seen.find((x) => x !== a && alike(x, a)) : undefined;
        return twin ? apart(a, twin) : named;
    };
    return read.map((a) => ('unreadable' in a ? unreadable(a.unreadable) : row(a, { ...n, who }, a.other ? (copies.get(a.other) ?? null) : null)));
}

/**
 * The copies among the page's other sides, each with the address it copies. Of two alike (their first and last
 * characters the same, as a poisoner grinds them), the copy is the one that is not known, or, when neither or both
 * are, the one you never sent to and that moved less: dust, against a real payment. Alike addresses are as rare as one
 * in 10^10 by chance, so no amount is needed to tell.
 */
function copiesOn(done: Activity[], known: Address[]): Map<Address, Address> {
    const weight = new Map<Address, number>();
    const add = (a: Address, w: number) => weight.set(a, Math.max(weight.get(a) ?? 0, w));
    for (const a of known) add(a, Infinity);
    for (const a of done) {
        if (!a.other) continue;
        if (a.kind === 'send' && a.signed) add(a.other, Infinity); // you sent to it, signing
        else add(a.other, Math.max(0, ...a.moves.map((m) => Math.abs(Number(m.units)) / 10 ** m.decimals)));
    }
    const out = new Map<Address, Address>();
    const all = [...weight.keys()];
    for (const a of all) {
        if (weight.get(a) === Infinity) continue; // known, or sent to: never the copy
        const twin = all.find((b) => b !== a && alike(a, b) && weight.get(b)! >= weight.get(a)!);
        if (twin) out.set(a, twin);
    }
    return out;
}

const unreadable = (why: string): Row => ({ signature: null, time: null, icon: 'bang', tone: 'warn', title: [{ text: "Otus couldn't read this one" }], sub: [{ text: why }], details: [], address: null });

function row(a: Activity, n: Naming, copies: Address | null): Row {
    const [outs, ins] = [a.moves.filter((m) => m.units < 0n), a.moves.filter((m) => m.units > 0n)];
    const by = a.main ? n.program(a.main) : '';
    const head = headline(a, n, outs, ins, by);
    const taken = !a.signed && outs.length > 0; // a delegate of its tokens moved them
    const side = a.kind === 'send' ? 'to' : 'from';
    return {
        signature: a.signature,
        time: a.time,
        icon: head.icon,
        tone: a.error || head.danger ? 'danger' : copies || taken ? 'warn' : 'plain',
        title: head.title,
        sub: copies && a.other ? [{ text: `${side} ${n.who(a.other)} · copies ${apart(copies, a.other)}` }] : head.sub,
        details: details(a, n, copies),
        address: a.other ? { label: a.kind === 'send' ? 'To' : 'From', address: a.other, name: named(n, a.other), copy: !!copies } : null,
    };
}

// The line: what happened, in a few words, and with whom or through what.
function headline(a: Activity, n: Naming, outs: Move[], ins: Move[], by: string): { icon: RowIcon; title: Part[]; sub: Part[]; danger?: boolean } {
    const what = (m: Move, list: Move[]): Part[] => [{ text: quantity(m, n), way: m.units < 0n ? 'out' : 'in' }, ...(list.length > 1 ? [{ text: ` +${list.length - 1}` }] : [])];
    const lead = (list: Move[]) => list.find((m) => m.mint !== null) ?? list[0]; // a token before SOL that may be rent
    const words = (s: string): Part[] => (s ? [{ text: s }] : []);
    if (a.error) return { icon: 'cross', title: words(`Failed${by ? ` · ${by}` : ''}`), sub: words(a.payer === n.wallet ? 'Only the fee was spent' : 'Nothing of yours moved') };
    if (a.squads.length) {
        const moved = a.moves.flatMap((m, i): Part[] => [...(i ? [{ text: ' · ' }] : []), { text: `${m.units < 0n ? '−' : '+'}${quantity(m, n)}`, way: m.units < 0n ? 'out' : 'in' }]);
        return { icon: 'shield', title: words(`Squads · ${[...new Set(a.squads.map((s) => VERBS[s]))].join(', ')}`), sub: moved };
    }
    switch (a.kind) {
        case 'swap':
            return { icon: 'swap', title: [{ text: 'Swap ' }, ...what(outs[0], outs), { text: ' → ' }, ...what(ins[0], ins)], sub: words(by) };
        case 'send':
            return { icon: 'send', title: [{ text: a.signed ? 'Sent ' : 'Moved ' }, ...what(lead(outs), outs)], sub: words(a.other ? `to ${n.who(a.other)}` : by) };
        case 'receive':
            return { icon: 'receive', title: [{ text: 'Received ' }, ...what(lead(ins), ins)], sub: words(a.other ? `from ${n.who(a.other)}` : by) };
        case 'mint': {
            const token = lead(ins);
            // What it cost, when something went for it: an NFT, a pool or stake token paid for.
            const paid = outs.length ? [{ text: 'for ' }, ...what(outs[0], outs)] : [];
            return { icon: 'plus', title: [{ text: 'Minted ' }, ...what(token, ins)], sub: paid.length ? paid : words(token.mint && a.created.includes(token.mint) ? 'New token' : by) };
        }
        case 'burn':
            return { icon: 'trash', title: [{ text: 'Burned ' }, ...what(lead(outs), outs)], sub: words(by) };
    }
    const about = subjectOf(a);
    if (about) {
        const told = story({ ...about.told, data: new Uint8Array() }, namesFor(a, n));
        const title = about.told.name === 'DelegateStake' && a.staked > 0n ? `Staked ${sol(a.staked)} SOL` : titleOf(about.told.name); // how much, when it went into a stake account of yours
        return { icon: iconOf(about.told.name), title: words(title), sub: words(told.args ? cap(told.args) : ''), danger: told.effects.some((e) => e.tone === 'danger') };
    }
    if (a.rent.yours < 0n) return { icon: 'box', title: words('Closed a token account'), sub: words(`${sol(-a.rent.yours)} SOL of rent freed`) };
    if (a.rent.yours > 0n) return { icon: 'box', title: words('Opened a token account'), sub: words(by) };
    if (a.rent.opened > 0n) return { icon: 'box', title: words('Opened an account'), sub: words(`${sol(a.rent.opened)} SOL of rent`) };
    // Named by its programs, but never by those Otus adds to what it signs (limits, guards).
    const programs = a.programs.filter((p) => p !== COMPUTE_BUDGET_PROGRAM_ADDRESS && p !== LIGHTHOUSE).map((p) => n.program(p));
    return { icon: 'box', title: words(by || programs[0] || 'Transaction'), sub: words(by ? '' : programs.slice(1).join(', ')) };
}

// What says nothing of what a transaction is for: its limits and fee, a note, the guards Otus adds.
const BACKGROUND = new Set<string>([COMPUTE_BUDGET_PROGRAM_ADDRESS, LIGHTHOUSE, MEMO_PROGRAM_ADDRESS, LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3]);

// The instruction a transaction that moved no balance is about: the last of Solana's own besides the background (a nonce
// account opened after the account it opens; an approval after the account it may open). None when it calls another
// program: then it goes by that program.
function subjectOf(a: Activity): { told: Told; index: number } | null {
    const about = a.instructions.map((told, index) => ({ told, index })).filter(({ told }) => !BACKGROUND.has(told.program));
    if (!about.length || about.some(({ told }) => told.source === 'unknown')) return null;
    return about[about.length - 1];
}

// A title in the past for what moved no balance; any instruction not here goes by its own name ("Sync native").
const TITLES: Record<string, string> = {
    Approve: 'Approved a delegate',
    ApproveChecked: 'Approved a delegate',
    Revoke: 'Revoked a delegate',
    SetAuthority: 'Changed an authority',
    FreezeAccount: 'Froze a token account',
    ThawAccount: 'Thawed a token account',
    CloseAccount: 'Closed a token account',
    InitializeAccount: 'Opened a token account',
    InitializeAccount2: 'Opened a token account',
    InitializeAccount3: 'Opened a token account',
    InitializeMint: 'Created a token',
    InitializeMint2: 'Created a token',
    CreateAccount: 'Opened an account',
    CreateAccountWithSeed: 'Opened an account',
    Assign: 'Gave an account to a program',
    AssignWithSeed: 'Gave an account to a program',
    InitializeNonceAccount: 'Opened a nonce account',
    AdvanceNonceAccount: 'Moved a nonce on',
    AuthorizeNonceAccount: 'Changed a nonce authority',
    WithdrawNonceAccount: 'Withdrew from a nonce account',
    Initialize: 'Opened a stake account',
    InitializeChecked: 'Opened a stake account',
    DelegateStake: 'Staked SOL',
    Deactivate: 'Unstaked',
    Withdraw: 'Withdrew from a stake account',
    Authorize: 'Changed a stake authority',
    AuthorizeChecked: 'Changed a stake authority',
    Split: 'Split a stake account',
    Merge: 'Merged stake accounts',
    SetLockup: 'Changed a stake lockup',
    SetLockupChecked: 'Changed a stake lockup',
};
const titleOf = (name: string) => TITLES[name] ?? cap(name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase());
const iconOf = (name: string): RowIcon => (/Approve|Revoke|Authori/.test(name) ? 'key' : /Nonce/.test(name) ? 'refresh' : /^Assign/.test(name) ? 'bang' : 'box');

// What the review's words need, from what the transaction listed: your token accounts by their token, a nonce account
// it sets up as one, the rest by name.
function namesFor(a: Activity, n: Naming): Names {
    const held = new Map(a.held.map((h) => [h.address, h]));
    const decimals = new Map(a.held.map((h) => [h.mint, h.decimals]));
    const yours = (x: Address) => held.get(x)?.owner === n.wallet;
    const nonces = new Set(a.instructions.flatMap((t) => (t.name === 'InitializeNonceAccount' ? t.accounts.filter((x) => x.role === 'nonceAccount').map((x) => x.address) : [])));
    return {
        wallet: n.wallet,
        who: (x) => (yours(x) ? `your ${n.symbol(held.get(x)!.mint)} account` : nonces.has(x) ? `nonce ${n.who(x)}` : n.who(x)),
        mine: (x) => x === n.wallet || yours(x),
        existed: (x) => !a.fresh.includes(x),
        mintOf: (x) => held.get(x)?.mint ?? null,
        token: (mint) => ({ symbol: mint ? n.symbol(mint) : 'tokens', decimals: mint ? (decimals.get(mint) ?? null) : null, verified: false }),
        program: (x) => n.program(x),
        priorityFee: null,
        payer: a.payer,
        changes: () => [],
    };
}

// A name for an address when Otus has one: yours, a contact's, a program's.
const named = (n: Naming, a: Address) => (/…/.test(n.who(a)) ? null : n.who(a));

/** An address cut short where it parts from one made to look like it, not just at four characters a side: the ones a
 *  copy matches. "EhPya…mBFDX" against "EhPyS…7BFDX". */
export function apart(a: string, b: string): string {
    let head = 0;
    while (head < a.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const [h, t] = [Math.max(4, head + 1), Math.max(4, tail + 1)];
    return h + t >= a.length ? a : `${a.slice(0, h)}…${a.slice(-t)}`;
}

// How much moved, unsigned, and of what.
const quantity = (m: Move, n: Naming) => `${amount(m.units < 0n ? -m.units : m.units, m.decimals, false)} ${m.mint === null ? 'SOL' : n.symbol(m.mint)}`;

// Opened: every balance it moved, the rent and the fee apart, the warnings, its programs, memo and failure.
function details(a: Activity, n: Naming, copies: Address | null): Detail[] {
    const out: Detail[] = a.moves.map((m) => ({ text: `${m.units < 0n ? '−' : '+'}${quantity(m, n)}`, tone: m.units > 0n ? 'ok' : 'danger' }));
    if (copies && a.other) {
        const [it, real] = [apart(a.other, copies), apart(copies, a.other)];
        out.push({ text: a.kind === 'send' ? `${it} looks like ${real}: one of them may be forged` : `Dust from ${it}, made to look like ${real}: never send to it`, tone: 'warn' });
    }
    // What moved no balance, as the review words each instruction of Solana's own.
    if (a.kind === 'other') {
        const names = namesFor(a, n);
        a.instructions.forEach((told) => {
            if (told.source !== 'plugin' || BACKGROUND.has(told.program)) return;
            for (const e of story({ ...told, data: new Uint8Array() }, names).effects) out.push({ text: e.text, ...(e.tone === 'danger' || e.tone === 'warn' ? { tone: e.tone } : {}) });
        });
    }
    if (!a.signed && a.moves.some((m) => m.units < 0n)) out.push({ text: "You didn't sign it: a delegate of your tokens moved them", tone: 'warn' });
    if (a.error) out.push({ text: `Failed: ${a.error}`, tone: 'danger' });
    if (a.rent.yours > 0n) out.push({ text: `${sol(a.rent.yours)} SOL of rent in a token account of yours: back when it closes`, tone: 'dim' });
    if (a.rent.yours < 0n) out.push({ text: `${sol(-a.rent.yours)} SOL of rent freed from a token account of yours, closed`, tone: 'dim' });
    if (a.rent.theirs > 0n) out.push({ text: `${sol(a.rent.theirs)} SOL to open their token account`, tone: 'dim' });
    if (a.rent.opened > 0n) out.push({ text: `${sol(a.rent.opened)} SOL of rent in the accounts it opened`, tone: 'dim' });
    out.push({ text: `Fee ${sol(a.fee)} SOL, paid by ${n.who(a.payer)}`, tone: 'dim' });
    if (a.memo) out.push({ text: `Memo “${a.memo}”`, tone: 'dim' });
    if (a.programs.length) out.push({ text: a.programs.map((p) => n.program(p)).join(' · '), tone: 'dim' });
    return out;
}

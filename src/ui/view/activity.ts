// A wallet's transactions as Activity shows them: each in a line ("Swap 1 SOL → 120.58 USDC", "Sent 12 USDT", to
// whom, when), what came in and what went out told apart; opened, everything its transaction told: every balance it
// moved, the rent and the fee apart, the other side whole, its programs, memo and failure. A copy of an address, the
// kind dust is sent from, is told as one.
import type { Address } from '@solana/kit';

import type { Activity, Move } from '@otus-wallet/sdk/activity/summary';
import { alike } from '../../shell/state.ts';
import { amount, short, sol } from '@otus-wallet/sdk/format';
import type { Step } from '@otus-wallet/sdk/programs/squads';

export type RowIcon = 'send' | 'receive' | 'swap' | 'shield' | 'box' | 'cross' | 'bang';
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
        tone: a.error ? 'danger' : copies || taken ? 'warn' : 'plain',
        title: head.title,
        sub: copies && a.other ? [{ text: `${side} ${n.who(a.other)} · copies ${apart(copies, a.other)}` }] : head.sub,
        details: details(a, n, copies),
        address: a.other ? { label: a.kind === 'send' ? 'To' : 'From', address: a.other, name: named(n, a.other), copy: !!copies } : null,
    };
}

// The line: what happened, in a few words, and with whom or through what.
function headline(a: Activity, n: Naming, outs: Move[], ins: Move[], by: string): { icon: RowIcon; title: Part[]; sub: Part[] } {
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
    }
    if (a.rent.yours < 0n) return { icon: 'box', title: words('Closed a token account'), sub: words(`${sol(-a.rent.yours)} SOL of rent freed`) };
    if (a.rent.yours > 0n) return { icon: 'box', title: words('Opened a token account'), sub: words(by) };
    const programs = a.programs.map((p) => n.program(p));
    return { icon: 'box', title: words(by || programs[programs.length - 1] || 'Transaction'), sub: words(by ? '' : programs.slice(0, -1).join(', ')) };
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
    if (!a.signed && a.moves.some((m) => m.units < 0n)) out.push({ text: "You didn't sign it: a delegate of your tokens moved them", tone: 'warn' });
    if (a.error) out.push({ text: `Failed: ${a.error}`, tone: 'danger' });
    if (a.rent.yours > 0n) out.push({ text: `${sol(a.rent.yours)} SOL of rent in a token account of yours: back when it closes`, tone: 'dim' });
    if (a.rent.yours < 0n) out.push({ text: `${sol(-a.rent.yours)} SOL of rent freed from a token account of yours, closed`, tone: 'dim' });
    if (a.rent.theirs > 0n) out.push({ text: `${sol(a.rent.theirs)} SOL to open their token account`, tone: 'dim' });
    out.push({ text: `Fee ${sol(a.fee)} SOL, paid by ${n.who(a.payer)}`, tone: 'dim' });
    if (a.memo) out.push({ text: `Memo “${a.memo}”`, tone: 'dim' });
    if (a.programs.length) out.push({ text: a.programs.map((p) => n.program(p)).join(' · '), tone: 'dim' });
    return out;
}

// Squads proposals, in words: what you do to each (create, approve, reject, execute…), how its votes stand, and what it
// would make its vault do, its instructions told as any transaction's, from the vault's side: the vault and its token
// accounts are what it holds, so what takes them is said as a loss. What Otus could not read is said too.
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import type { Address } from '@solana/kit';

import { amount, plural, sol } from '@otus-wallet/sdk/format';
import type { ConfigAction, Step } from '@otus-wallet/sdk/programs/squads';
import type { Tone } from '@otus-wallet/sdk/review/assess';
import { story, type Names } from '@otus-wallet/sdk/review/effects';
import type { Explained } from '@otus-wallet/sdk/review/explain';
import type { Inside, ProposalTold, Unread } from '@otus-wallet/sdk/review/squads';
import { atAddresses, YOU } from './names.ts';

/** A proposal as the window shows it: which, what you do to it, what it does, then how its votes stand. */
export type ProposalView = { title: string; you: string; lines: Line[]; after: string };
type Line = { text: string; tone: Tone };

const VERBS: Record<Step, string> = { setup: 'set up', create: 'create', propose: 'propose', activate: 'activate', approve: 'approve', reject: 'reject', cancel: 'cancel', execute: 'execute', spend: 'spend', close: 'close' };

const UNREAD: Record<Unread, string> = {
    accounts: "Otus couldn't load every account it runs with, so can't say what it does",
    instruction: "A Squads instruction Otus can't read: what it does is unsaid",
    more: 'More Squads instructions than Otus reads: the rest is unsaid',
    time: "Otus couldn't read its Squads proposals in time: what they do is unsaid",
};

export function proposalViews(told: ProposalTold[], n: Names): ProposalView[] {
    return told.map((t) => ({ title: title(t), you: you(t), lines: lines(t.inside, n), after: after(t) }));
}

function title(t: ProposalTold): string {
    if (!t.steps.length) return 'Squads';
    if (t.inside.kind === 'spend') return 'Squads spending limit';
    if (t.inside.kind === 'setup') return 'New Squads multisig';
    return `Squads proposal${t.number === null ? '' : ` #${t.number}`}`;
}

// What you do to it, before what it does.
function you(t: ProposalTold): string {
    if (!t.steps.length) return '';
    if (t.steps.includes('spend')) return 'You send within a spending limit, with no vote:';
    if (t.steps.includes('setup')) return 'You create a multisig:';
    if (t.steps.includes('close')) return "You close a done proposal's accounts:";
    const verbs = [...new Set(t.steps)].map((s) => VERBS[s]);
    return `You ${verbs.length > 1 ? `${verbs.slice(0, -1).join(', ')} and ${verbs.at(-1)}` : verbs[0]}:`;
}

// After what it does: its approvals as they stand where you vote on it (with yours, when you approve one still open),
// and a proposal done with already.
function after(t: ProposalTold): string {
    const done = t.status && ['executed', 'cancelled', 'rejected'].includes(t.status) ? `It was ${t.status} already` : '';
    if (t.threshold === null || !(t.steps.includes('approve') || t.steps.includes('reject'))) return done;
    const votes = t.status === 'approved' ? `It has ${t.approved} of ${t.threshold} approvals already` : t.steps.includes('approve') ? `${t.approved + 1} of ${t.threshold} approvals with yours` : `It has ${t.approved} of ${t.threshold} approvals`;
    return done ? `${votes}. ${done}` : votes;
}

// An address as the proposal's lines give it, always at a line's end, which the window shows on its own: whole, as an
// address that only looks like another passes for it when cut short; yours marked " (you)", shown as a tag; a program
// by its name.
const whole = (n: Names, a: Address) => {
    const named = n.who(a);
    return named === 'you' ? `${a}${YOU}` : named;
};


/** A proposal line's words, and the addresses it ends with (who gets what the vault sends, a member, who may spend; each
 *  may be marked yours, and a list parted by commas), for the window to show each whole on a line of its own. An
 *  address in the words (a mint, a program) stays among them. */
export function partiesOf(line: string): { words: string; parties: string[] } {
    const at = atAddresses(line);
    let first = at.length; // the first of the addresses the line ends with, if any
    for (let i = at.length - 2; i >= 1; i -= 2) {
        const after = at[i + 1].startsWith(YOU) ? at[i + 1].slice(YOU.length) : at[i + 1];
        if (!(i === at.length - 2 ? after === '' : /^,\s*$/.test(after))) break;
        first = i;
    }
    return { words: at.slice(0, first).join(''), parties: at.filter((_, i) => i >= first && i % 2 === 1) };
}

// What it would do, as lines.
function lines(inside: Inside, base: Names): Line[] {
    const line = (text: string, tone: Tone = 'plain'): Line => ({ text, tone });
    switch (inside.kind) {
        case 'vault': {
            const n = fromVault(base, inside);
            if (!inside.explained.length) return [line(`${cap(vaultName(inside.vaultIndex))} runs nothing`)];
            return inside.explained.flatMap((e) => {
                if (opened(e, n)) return []; // an account opened only if missing, and there already: nothing happens
                if (e.source === 'unknown') return [line(`Calls ${base.program(e.program)}, which Otus can't read`, 'warn')];
                const effects = story(e, n).effects;
                return effects.length ? effects.map((f) => line(f.text, f.tone)) : [line(`${e.programName ?? base.program(e.program)}: ${e.name}, which Otus has no words for`, 'warn')];
            });
        }
        case 'config':
            return inside.actions.flatMap((a) => config(a, base));
        case 'batch':
            if (!inside.size) return [line(`Starts a batch of transactions from ${vaultName(inside.vaultIndex)}`)];
            return [line(`Runs ${plural(inside.size, 'transaction')} from ${vaultName(inside.vaultIndex)}:`), ...inside.runs.flatMap((run, i) => lines(run, base).map((l) => ({ ...l, text: `${i + 1}. ${l.text}` })))];
        case 'spend': {
            const t = base.token(inside.mint);
            const what = inside.mint === null ? `${sol(inside.amount)} SOL` : `${amount(inside.amount, inside.decimals, false)} ${t.symbol}`;
            return [line(`${what} from vault to ${whole(base, inside.destination)}`)];
        }
        case 'setup': {
            const members = inside.members.map((m) => line(`Member${may(m.permissions)}: ${whole(base, m.key)}`));
            return [...members, line(`It takes ${plural(inside.threshold, 'approval')}${inside.timeLock ? `, then waits ${plural(inside.timeLock, 'second')}` : ''}`)];
        }
        case 'close':
            return [line(`Their rent goes to: ${whole(base, inside.rentCollector)}`)];
        case 'gone':
            return [line("Otus can't find its transaction, so can't say what it runs", 'warn')];
        case 'unread':
            return [line(UNREAD[inside.why], 'warn')];
    }
}

/** A vault by name: "vault" for the first, which most multisigs use alone; "vault 2" for another. */
const vaultName = (index: number) => (index === 0 ? 'vault' : `vault ${index}`);
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

// An associated token account opened only if missing (CreateIdempotent) that is there already.
function opened(e: Explained, n: Names): boolean {
    const ata = e.accounts.find((a) => a.role === 'ata')?.address;
    return e.program === ASSOCIATED_TOKEN_PROGRAM_ADDRESS && e.name.includes('Idempotent') && !!ata && n.existed(ata);
}

// The words for a vault's transaction: the vault and its token accounts as the vault, and as what is held (a loss of
// them is said as one), others' token accounts by their owner; whether an account exists, as the proposal finds it.
function fromVault(n: Names, inside: Extract<Inside, { kind: 'vault' }>): Names {
    const tokens = new Map(inside.accounts.flatMap((a) => (a.token ? [[a.address, a.token] as const] : [])));
    const exists = new Map(inside.accounts.map((a) => [a.address, a.exists]));
    const held = (a: Address) => a === inside.vault || tokens.get(a)?.owner === inside.vault;
    return {
        ...n,
        who: (a: Address) => {
            if (held(a)) return vaultName(inside.vaultIndex);
            const t = tokens.get(a);
            return whole(n, t ? t.owner : a);
        },
        mine: (a: Address) => held(a) || n.mine(a),
        existed: (a: Address) => exists.get(a) ?? n.existed(a),
        mintOf: (a: Address) => tokens.get(a)?.mint ?? n.mintOf(a),
    };
}

const PERMISSIONS: [number, string][] = [
    [1, 'propose'],
    [2, 'vote'],
    [4, 'execute'],
];
const may = (mask: number) => {
    const words = PERMISSIONS.filter(([bit]) => mask & bit).map(([, w]) => w);
    return words.length ? ` who may ${words.join(', ')}` : ' who may do nothing';
};

function config(a: ConfigAction, n: Names): Line[] {
    const warn = (text: string): Line => ({ text, tone: 'warn' });
    switch (a.kind) {
        case 'addMember':
            return [warn(`Adds a member${may(a.permissions)}: ${whole(n, a.member)}`)];
        case 'removeMember':
            return [warn(`Removes a member: ${whole(n, a.member)}`)];
        case 'threshold':
            return [warn(`Makes it take ${plural(a.threshold, 'approval')}`)];
        case 'timeLock':
            return [warn(a.seconds ? `Makes an approved proposal wait ${plural(a.seconds, 'second')} before it runs` : 'Lets an approved proposal run at once')];
        case 'addSpendingLimit': {
            const t = n.token(a.mint);
            const what = a.mint === ('11111111111111111111111111111111' as Address) ? `${sol(a.amount)} SOL` : `${t.decimals === null ? `${a.amount} units of` : amount(a.amount, t.decimals, false)} ${t.symbol}`;
            const when = { once: 'once', day: 'a day', week: 'a week', month: 'a month' }[a.period];
            return [
                warn(`Adds a spending limit: up to ${what} ${when} from ${vaultName(a.vaultIndex)}, with no vote`),
                ...a.members.map((m) => warn(`Who may use it: ${whole(n, m)}`)),
                ...(a.destinations.length ? a.destinations.map((d) => warn(`Only to: ${whole(n, d)}`)) : [warn('To any address')]),
            ];
        }
        case 'removeSpendingLimit':
            return [{ text: `Removes a spending limit: ${a.spendingLimit}`, tone: 'plain' }];
        case 'rentCollector':
            return [{ text: a.collector ? `The rent of closed proposals goes to: ${whole(n, a.collector)}` : 'Stops collecting the rent of closed proposals', tone: 'plain' }];
    }
}

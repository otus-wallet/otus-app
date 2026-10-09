// The programs as the window lists them: where each stands with the wallet, what it gets, whether it can change, what
// it calls inside, and its instructions in words.
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
import type { Address } from '@solana/kit';

import { cap, short, told } from '@otus-wallet/sdk/format';
import { CORE_PROGRAMS } from '@otus-wallet/sdk/programs/core';
import { PROGRAM_NAMES } from '@otus-wallet/sdk/programs/known';
import type { Finding, Level, ProgramUse, Verdict } from '@otus-wallet/sdk/review/assess';
import { story, type Names } from '@otus-wallet/sdk/review/effects';
import type { Explained } from '@otus-wallet/sdk/review/explain';
import type { IdlInstruction } from '@otus-wallet/sdk/idl/idl';
import type { Deployment } from '@otus-wallet/sdk/review/programs';
import type { Review } from '@otus-wallet/sdk/review/review';
import type { InstructionView, ProgramView } from '../view.ts';

// The programs, in the order the transaction first calls them, each with its instructions; those no plugin reads as
// their IDLs tell them (`told`, by their place), where they publish one. `named`: the programs Otus doesn't know that
// their own IDLs describe, by the name each gives itself.
export function programs(r: Review, findings: Finding[], n: Names, verdict: Verdict, told: Map<number, IdlInstruction>, named: Map<Address, string>): ProgramView[] {
    const levelOf = (program: Address, codes: string[]) => findings.find((f) => f.subject === program && codes.includes(f.code) && f.level !== 'ok')?.level ?? null;
    const accounts = new Map(r.accounts.map((a) => [a.address, a]));
    return r.assessment.programs.map((use) => {
        // In a review that is critical anyway, a program Otus doesn't know that gets you is a suspect: its card, and
        // your accounts in its instructions, show red. Otherwise it is as what is found of it says.
        const suspect = use.name === null && (use.signature || use.writable) && verdict === 'danger';
        // The channel of what leaves you: a known program too, then, shows how it went.
        const channel = findings.find((f) => f.programs?.includes(use.program) && (f.level === 'danger' || f.level === 'warn'))?.level ?? null;
        const own = levelOf(use.program, ['imitation-program', 'reaches-holdings', 'reach-unseen', 'unknown-program']);
        const level = suspect ? 'danger' : worse(own, channel);
        const instructions = r.explained.flatMap((e, i) => (e.program === use.program ? [instructionView(e, i, accounts, n, level === 'danger', told.get(i))] : []));
        return programView(r, use, level, instructions, named.get(use.program) ?? null);
    });
}

/** The programs Otus doesn't know whose own IDLs tell every instruction of theirs here no plugin reads, by the name
 *  each gives itself, as a title ("raptorV1" → "Raptor V1"). */
export function selfNamed(r: Review, told: Map<number, IdlInstruction>): Map<Address, string> {
    const named = new Map<Address, string>();
    for (const use of r.assessment.programs) {
        if (use.name !== null) continue;
        const unread = r.explained.flatMap((e, i) => (e.program === use.program && e.source === 'unknown' ? [i] : []));
        const names = unread.map((i) => told.get(i)?.program);
        if (names.length && names.every((name) => name)) named.set(use.program, names[0]!.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()));
    }
    return named;
}

// One instruction: what it is called, its arguments and accounts, and what it does in words. One no plugin reads takes
// its name, arguments and account names from its program's IDL (`idl`), where that tells it; what it does stays what
// the simulation shows.
function instructionView(e: Explained, i: number, accounts: Map<Address, Review['accounts'][number]>, n: Names, risky: boolean, idl?: IdlInstruction): InstructionView {
    const told = story(e, n, risky, i === 0);
    return {
        number: i + 1,
        name: idl?.name ?? e.name,
        args: idl ? idl.args : told.args,
        source: sourceOf(e, idl),
        accounts: (idl?.accounts ?? e.accounts).map(({ role, address }) => {
            const a = accounts.get(address);
            const roleText = [role, a?.signer && 'signer', a?.writable && 'writable', !a?.state.exists && 'new'].filter(Boolean).join(' · ');
            return { name: cap(n.who(address)), role: roleText, tone: risky && n.mine(address) ? 'danger' : 'plain' };
        }),
        effects: told.effects,
    };
}

function sourceOf(e: Explained, idl: IdlInstruction | undefined): InstructionView['source'] {
    if (idl) return 'idl';
    if (e.source === 'unknown') return 'unknown';
    return CORE_PROGRAMS.has(e.program) ? 'core' : 'plugin';
}

function programView(r: Review, use: ProgramUse, level: Level | null, instructions: InstructionView[], self: string | null): ProgramView {
    const [meta, metaTone] = mutability(r.deployments.get(use.program));
    const standing = standingOf(use, self);
    return {
        name: use.name ?? self ?? 'Unknown program',
        address: use.program,
        standing,
        tone: standing === 'known' ? (level === 'danger' || level === 'warn' ? level : 'ok') : (level ?? 'notice'),
        sub: getsOf(use),
        subTone: level === 'danger' || level === 'warn' ? level : 'plain',
        meta,
        metaTone,
        inner: innerCalls(r, use.program),
        instructions,
    };
}

function standingOf(use: ProgramUse, self: string | null): ProgramView['standing'] {
    if (use.name !== null) return 'known';
    return self ? 'described' : 'unknown';
}

// What a program uses of yours, as plain fact: that it asks for your signature is how any app works, and what it does
// with it is what the review judges.
function getsOf(use: ProgramUse): string {
    if (use.accounts > 0) return `Uses ${use.accounts} of your accounts`;
    if (use.signature) return 'Uses your signature';
    return use.program === COMPUTE_BUDGET_PROGRAM_ADDRESS ? 'Fee settings · touches nothing of yours' : 'Touches nothing of yours';
}

// Whether its authority can still change it. How recently it was deployed counts in the findings, for a program
// Otus cannot name.
function mutability(d: Deployment | undefined): [string, ProgramView['metaTone']] {
    if (d?.builtin) return ['Built into Solana', 'plain'];
    if (d?.upgradeable === true) return ['Mutable program', 'info'];
    if (d?.upgradeable === false) return ['Immutable program', 'ok'];
    return ['', 'plain'];
}

// What a program calls inside, by program, with how many times each instruction.
function innerCalls(r: Review, program: Address): string {
    const inner = new Map<string, Map<string, number>>();
    r.message.instructions.forEach((ix, i) => {
        if (r.accounts[ix.programAddressIndex].address !== program) return;
        for (const call of r.simulation.inner.find((g) => g.index === i)?.calls ?? []) {
            const callee = PROGRAM_NAMES.get(call.program) ?? short(call.program);
            const kinds = inner.get(callee) ?? new Map<string, number>();
            const type = call.type ? cap(told(call.type, 40)) : '';
            if (type) kinds.set(type, (kinds.get(type) ?? 0) + 1);
            inner.set(callee, kinds);
        }
    });
    return [...inner].map(([callee, kinds]) => (kinds.size ? `${callee} (${[...kinds].map(([k, c]) => (c > 1 ? `${k} ×${c}` : k)).join(', ')})` : callee)).join(', ');
}

// The worse of two levels, or the one there is.
const RANK = { danger: 0, warn: 1, notice: 2, ok: 3 } as const;
function worse<L extends keyof typeof RANK>(a: L | null, b: L | null): L | null {
    if (a === null || b === null) return a ?? b;
    return RANK[a] <= RANK[b] ? a : b;
}

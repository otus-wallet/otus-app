// What a transaction does to Squads proposals, read for the review: the proposals its Squads instructions create, vote on
// or run, where each stands, and what each would make its vault do, explained by Otus's own plugins. What a proposal
// runs is read from the instruction that carries it, or else from the account Squads keeps it in. What Otus cannot
// read is said, never left out.
import type { Address } from '@solana/kit';

import type { Chain } from '../chain.ts';
import {
    batchTransactionAt,
    proposalAt,
    readCall,
    readKept,
    readMultisig,
    readProposal,
    SQUADS_V4,
    transactionAt,
    vaultAt,
    type Call,
    type ConfigAction,
    type Inner,
    type Proposal,
    type Step,
} from '../programs/squads.ts';
import { read } from './changes.ts';
import { explain, type Explained } from './explain.ts';
import { loadTables } from './resolve.ts';
import type { Review } from './review.ts';

/** An account a proposal's transaction names, as Otus knows it now: whether it exists, and a token account's mint and
 *  owner. */
export type InnerAccount = { address: Address; exists: boolean; token: { mint: Address; owner: Address } | null };

/** Why what a proposal does goes unsaid: accounts Otus could not load, an instruction it cannot read, more of them
 *  than it reads, or no answer in time. */
export type Unread = 'accounts' | 'instruction' | 'more' | 'time';

/** What a proposal would do: run a transaction from a vault (its instructions, explained), change the multisig, run a
 *  batch (each of its transactions), or (with a spending limit, at once) move funds from a vault; set up a multisig,
 *  or close a done proposal's accounts. `gone`: its transaction account is not there. */
export type Inside =
    | { kind: 'vault'; vault: Address; vaultIndex: number; explained: Explained[]; accounts: InnerAccount[] }
    | { kind: 'config'; actions: ConfigAction[] }
    | { kind: 'batch'; vault: Address; vaultIndex: number; size: number; runs: Inside[] }
    | { kind: 'spend'; vault: Address; amount: bigint; decimals: number; mint: Address | null; destination: Address }
    | { kind: 'setup'; threshold: number; members: { key: Address; permissions: number }[]; timeLock: number }
    | { kind: 'close'; rentCollector: Address }
    | { kind: 'gone' }
    | { kind: 'unread'; why: Unread };

/** One proposal the transaction acts on: the instructions that do (by their place) and what each does to it, its
 *  multisig and number, its votes and standing before the transaction, and what it would do. */
export type ProposalTold = {
    instructions: number[];
    steps: Step[];
    multisig: Address;
    number: bigint | null;
    threshold: number | null;
    approved: number;
    rejected: number;
    status: Proposal['status'] | null;
    inside: Inside;
};

const MAX_CALLS = 8; // Squads instructions read in one transaction; more are said to be unread
const MAX_BATCH = 8; // transactions of a batch read

/** The proposals a transaction acts on, in its order, and what of it Otus could not read. Reads the chain; throws only
 *  as the chain does. */
export async function squadsTold(r: Review, chain: Chain): Promise<ProposalTold[]> {
    const calls: { at: number; call: Call }[] = [];
    const unread: ProposalTold[] = [];
    let more = -1; // the place of the first Squads instruction past those read
    r.message.instructions.forEach((ix, at) => {
        if (r.accounts[ix.programAddressIndex].address !== SQUADS_V4) return;
        if (calls.length >= MAX_CALLS) {
            if (more < 0) more = at;
            return;
        }
        let call: Call | null = null;
        try {
            call = readCall(ix.data, ix.accountIndices.map((i) => r.accounts[i].address));
        } catch {} // data Squads would refuse, or that Otus reads otherwise
        if (call) calls.push({ at, call });
        else unread.push(notice(at, 'instruction'));
    });
    if (more >= 0) unread.push(notice(more, 'more'));
    if (!calls.length) return unread;
    const state = await states(
        r,
        chain,
        calls.flatMap(({ call }) => [call.multisig, call.proposal].filter((a): a is Address => !!a)),
    );
    // Each call with what it would do; calls on one proposal and the same transaction of it make one entry. A spend, a
    // setup, or a call of no number, stands alone.
    const each = await Promise.all(
        calls.map(async ({ at, call }) => {
            const multisig = state(call.multisig, readMultisig);
            const proposal = call.proposal ? state(call.proposal, readProposal) : null;
            const number = await numberOf(call, proposal, multisig?.transactionIndex ?? null, calls);
            const source = call.transaction ?? call.batch ?? (number !== null ? await transactionAt(call.multisig, number) : '');
            const key = number === null || call.spend || call.setup ? `@${at}` : `${call.multisig}#${number}#${source}`;
            return { at, call, key, multisig, proposal, number, inside: await inside(call, number, r, chain) };
        }),
    );
    const told = new Map<string, ProposalTold>();
    for (const { at, call, key, multisig, proposal, number, inside } of each) {
        const seen = told.get(key);
        if (seen) {
            seen.instructions.push(at);
            seen.steps.push(call.step);
            continue;
        }
        told.set(key, {
            instructions: [at],
            steps: [call.step],
            multisig: call.multisig,
            number,
            threshold: call.setup?.threshold ?? multisig?.threshold ?? null,
            approved: proposal?.approved.length ?? 0,
            rejected: proposal?.rejected.length ?? 0,
            status: proposal?.status ?? null,
            inside,
        });
    }
    return [...told.values(), ...unread].sort((a, b) => a.instructions[0] - b.instructions[0]);
}

/** An entry that says what went unread, at that place. */
export const notice = (at: number, why: Unread): ProposalTold => ({ instructions: [at], steps: [], multisig: SQUADS_V4, number: null, threshold: null, approved: 0, rejected: 0, status: null, inside: { kind: 'unread', why } });

// The proposal's number: given, as proposalCreate gives it; its proposal's; the one a proposalCreate of the same
// transaction gives the proposal or transaction this names; or, for a transaction being created, one more than the
// multisig's last.
async function numberOf(call: Call, proposal: Proposal | null, last: bigint | null, calls: { call: Call }[]): Promise<bigint | null> {
    if (call.index !== undefined) return call.index;
    if (proposal) return proposal.index;
    const named = call.transaction ?? call.batch;
    for (const { call: other } of calls) {
        if (other.step !== 'propose' || other.multisig !== call.multisig || other.index === undefined) continue;
        if ((await proposalAt(other.multisig, other.index)) === call.proposal || (await transactionAt(other.multisig, other.index)) === named) return other.index;
    }
    if (call.step === 'create' && last !== null && named && (await transactionAt(call.multisig, last + 1n)) === named) return last + 1n;
    return null;
}

// What the proposal would do: the transaction it carries, or the one its account keeps. One transaction of a batch runs
// from the batch's vault.
async function inside(call: Call, number: bigint | null, r: Review, chain: Chain): Promise<Inside> {
    if (call.setup) return { kind: 'setup', ...call.setup };
    if (call.spend) return { kind: 'spend', ...call.spend };
    if (call.actions) return { kind: 'config', actions: call.actions };
    if (call.rentCollector) return { kind: 'close', rentCollector: call.rentCollector };
    const batchVault = async () => {
        const batch = call.batch ? (await states(r, chain, [call.batch]))(call.batch, readKept) : null;
        return batch?.kind === 'batch' ? batch.vaultIndex : null;
    };
    if (call.name === 'batchCreate' && call.vaultIndex !== undefined) return { kind: 'batch', vault: await vaultAt(call.multisig, call.vaultIndex), vaultIndex: call.vaultIndex, size: 0, runs: [] };
    if (call.inner) {
        const vaultIndex = call.vaultIndex ?? (await batchVault());
        return vaultIndex === null ? { kind: 'unread', why: 'accounts' } : vaultRun(call.multisig, vaultIndex, call.inner, chain);
    }
    const where = call.transaction ?? (number !== null ? await transactionAt(call.multisig, number) : null);
    const loaded = where ? (await states(r, chain, [where]))(where, readKept) : null;
    if (!loaded) return { kind: 'gone' };
    if (loaded.kind === 'config') return { kind: 'config', actions: loaded.actions };
    if (loaded.kind === 'vault') return vaultRun(call.multisig, loaded.vaultIndex, loaded.inner, chain);
    if (loaded.kind === 'batch') return number === null ? { kind: 'unread', why: 'accounts' } : batchRuns(call.multisig, number, loaded.vaultIndex, loaded.size, r, chain);
    const vaultIndex = await batchVault();
    return vaultIndex === null ? { kind: 'unread', why: 'accounts' } : vaultRun(call.multisig, vaultIndex, loaded.inner, chain);
}

// A batch: each of its transactions, as its account keeps it; more than Otus reads are said to be unread.
async function batchRuns(multisig: Address, number: bigint, vaultIndex: number, size: number, r: Review, chain: Chain): Promise<Inside> {
    const places = await Promise.all(Array.from({ length: Math.min(size, MAX_BATCH) }, (_, i) => batchTransactionAt(multisig, number, i + 1)));
    const state = await states(r, chain, places);
    const runs = await Promise.all(
        places.map(async (place): Promise<Inside> => {
            const kept = state(place, readKept);
            return kept?.kind === 'batchTransaction' ? vaultRun(multisig, vaultIndex, kept.inner, chain) : { kind: 'gone' };
        }),
    );
    if (size > MAX_BATCH) runs.push({ kind: 'unread', why: 'more' });
    return { kind: 'batch', vault: await vaultAt(multisig, vaultIndex), vaultIndex, size, runs };
}

// A vault's transaction, explained as any other: its accounts (the ones its lookup tables add included), each as a
// signer or writable as its header says, and read for whether they exist and, as token accounts, their mint and owner.
async function vaultRun(multisig: Address, vaultIndex: number, inner: Inner, chain: Chain): Promise<Inside> {
    const vault = await vaultAt(multisig, vaultIndex);
    const tables = await loadTables(
        inner.lookups.map((l) => l.table),
        chain,
    ).catch(() => null);
    if (!tables) return { kind: 'unread', why: 'accounts' };
    const loaded = (kind: 'writable' | 'readonly') => inner.lookups.flatMap((l, t) => l[kind].map((i) => ({ address: tables[t][i], signer: false, writable: kind === 'writable' })));
    const keys = [
        ...inner.keys.map((address, i) => ({
            address,
            signer: i < inner.signers,
            writable: i < inner.signers ? i < inner.writableSigners : i < inner.signers + inner.writableNonSigners,
        })),
        ...loaded('writable'),
        ...loaded('readonly'),
    ];
    if (keys.some((k) => !k.address)) return { kind: 'unread', why: 'accounts' }; // an entry its table does not have
    const explained = explain({ message: { instructions: inner.instructions.map((ix) => ({ programAddressIndex: ix.program, accountIndices: ix.accounts, data: ix.data })) }, accounts: keys });
    const { accounts } = await chain.accounts(keys.map((k) => k.address));
    const known = accounts.map((a): InnerAccount => {
        const token = read(a)?.token;
        return { address: a.address, exists: a.exists, token: token ? { mint: token.mint, owner: token.owner } : null };
    });
    return { kind: 'vault', vault, vaultIndex, explained, accounts: known };
}

// Squads' accounts among these: as the review read them when the transaction names them, else from the chain. Each is
// read with the given reader, null when it is not there, not Squads', or not that.
async function states(r: Review, chain: Chain, addresses: Address[]) {
    const data = new Map(r.accounts.map((a) => [a.address as string, a.state.exists && a.state.programAddress === SQUADS_V4 ? a.state.data : null]));
    const missing = [...new Set(addresses)].filter((a) => !data.has(a));
    if (missing.length) {
        const { accounts } = await chain.accounts(missing);
        accounts.forEach((a) => data.set(a.address, a.exists && a.programAddress === SQUADS_V4 ? a.data : null));
    }
    return <T>(address: Address, reader: (data: Uint8Array) => T | null): T | null => {
        const d = data.get(address);
        if (!d) return null;
        try {
            return reader(Uint8Array.from(d));
        } catch {
            return null;
        }
    };
}

import {
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    getSetComputeUnitLimitInstructionDataEncoder,
    getSetComputeUnitPriceInstructionDataEncoder,
    getSetLoadedAccountsDataSizeLimitInstructionDataEncoder,
    MAX_COMPUTE_UNIT_LIMIT,
} from '@solana-program/compute-budget';
import { getTransactionEncoder, type Address, type ReadonlyUint8Array } from '@solana/kit';

import type { Chain, Simulation } from '../chain.ts';
import { callsIn, HIGH_FEE, HUGE_FEE, type Finding } from '../review/assess.ts';
import { budgetIndex, dataLimit, defaultUnits, fee, lamportsFor, MAX_ROOM, priorityFee, SET_LOADED_DATA, SET_UNIT_LIMIT, SET_UNIT_PRICE, unitLimit, unitPrice } from '../review/budget.ts';
import { decode, durable, encode, type Message } from '../review/decode.ts';
import type { Review } from '../review/review.ts';
import { short } from '../format.ts';
import { LIGHTHOUSE } from '../programs/addresses.ts';
import { PROGRAM_NAMES } from '../programs/known.ts';
import { assertions, holds, type Hold } from './guard.ts';

/** The transaction to sign, as the user approves it, and what preparing it found. */
/** Where a priority fee Otus sets comes from: the price the RPC recommends (Helius), or what recent blocks took. */
export type Pricing = 'recommended' | 'recent';

export type Prepared = {
    bytes: Uint8Array;
    hash: string;
    fee: bigint; // what its fee payer pays
    holds: Hold[]; // the guards it carries
    unguarded: string | null; // why it carries none
    findings: Finding[]; // added to the review's
    units: number | null; // the compute limit Otus set, when it changed the transaction
    priced: Pricing | null; // where the priority fee Otus set comes from, when it set one
    room: number | null; // the account data a v1 transaction may load, when Otus changed it
    priority: bigint | null; // lamports: the priority fee Otus set, when it set one
};

const GUARD_UNITS = 4_000; // compute units per assertion added to a site's own limit; Lighthouse uses about 2,000
const BUDGET_UNITS = 300; // what the Compute Budget instructions Otus adds use, 150 each
const SPARE = 1.1; // a fitted compute limit is what the transaction uses, guards and fee settings included, and a tenth
const PERCENTILE = 0.75; // of what recent blocks took to write the same accounts
const MAX_PRIORITY_FEE = 1_000_000n; // lamports: the most a priority fee set by the wallet costs
const FEE_ACCOUNTS = 128; // getRecentPrioritizationFees takes at most 128 addresses, getPriorityFeeEstimate 500
const ROOM_STEP = 32 * 1024; // bytes: a v1 data limit is rounded up to this, the step the network counts it by

/**
 * Review → the transaction to sign. When this wallet alone signs, it gets guards on your accounts, a compute limit fitted
 * to the simulation and, unless the site set one, a priority fee from recent fees; then it is simulated again. Otherwise,
 * or if that would fail, it stays as the site sent it, and says so. `own`: a transfer made in Otus, whose limits are
 * the most there is for its review, fitted here as if it set none. `bare`: why it gets no guards, only its limits and
 * fee. Never throws.
 */
export async function prepare(r: Review, wallet: Address, chain: Chain, own = false, bare?: string): Promise<Prepared> {
    const gross = bare ? [] : holds(r.assessment.yours, wallet, r.assessment.keyed);
    // As the site sent it, without guards: why, for the review's Guards line; and what else was found on the way.
    const asIs = (reason: string, findings: Finding[] = []): Prepared => ({ bytes: r.bytes, hash: r.hash, fee: r.changes.fee, holds: [], unguarded: reason, findings, units: null, priced: null, room: null, priority: null });
    if (r.signers.length > 1) return asIs("Another account signs it too, so Otus can't lock it");
    if (r.simulation.error !== null) return asIs('the simulation failed');
    const loaded = r.accounts.filter((a) => a.table).map((a) => a.address);
    if ([LIGHTHOUSE, COMPUTE_BUDGET_PROGRAM_ADDRESS].some((p) => loaded.includes(p))) return asIs("Its format doesn't let Otus lock it", [TABLED]);

    const guards = gross.map((h) => ({ hold: h, data: assertions(h, wallet) }));
    const added = guards.reduce((n, g) => n + g.data.length, 0);
    const accounts = r.accounts.map((a) => a.address);
    // A transaction loads no more account data than its limit, v1's or the one a Compute Budget instruction sets for
    // legacy and v0: Lighthouse's program comes with its guards. `room`: the limit as Otus sets it, null to leave the
    // site's.
    const v1 = r.message.version === 1;
    const siteRoom = own ? null : dataLimit(r.message);
    const roomed = v1 || siteRoom !== null;
    let room: number | null = null;
    const build = (h: Hold[], limit: number, price: bigint) => {
        const m = withRoom(withPrice(withLimit(withAssertions(r.message, h, wallet, accounts), limit), price), room);
        return bare ? budgetFirst(m) : m; // where a Ledger reads the rest in clear
    };
    const siteLimit = own ? null : unitLimit(r.message);
    // Guarded, it fails. For what Otus adds (more accounts or account data than a transaction may take, the rent its
    // priority fee leaves the wallet without, units the guards could have used up), it goes as the site sent it;
    // otherwise it acts other than reviewed. `limit`: the units it had.
    const failed = async (error: NonNullable<Simulation['error']>, limit: number) =>
        ours(error, { used: r.simulation.unitsConsumed, limit, added }) ? asIs("It's too full for Otus to lock it") : asIs('it fails with guards', [await whyFailed(r, chain)]);
    const sitePrice = r.message.version === 1 ? r.message.config.priorityFeeLamports : unitPrice(r.message);
    // The price asked of the network while the limit is measured, which needs none.
    const pricingAsked = sitePrice == null ? pricing(r, chain) : Promise.resolve(null);
    pricingAsked.catch(() => {}); // awaited below; one that fails is the network not answering
    let market: { price: bigint; from: Pricing } | null = null;
    try {
        // The transaction as it would be signed with this limit: priced under the cap, the wallet's floor net of what
        // it pays for it.
        const signable = (limit: number, priced = true) => {
            const price = !priced || market === null || market.price === 0n ? 0n : min(market.price, (MAX_PRIORITY_FEE * 1_000_000n) / BigInt(Math.max(limit, 1)));
            const paid = r.signers[0] === wallet ? fee(build(gross, limit, price)) : 0n;
            const held = gross.map((h) => (h.kind === 'wallet' ? { ...h, atLeast: h.atLeast > paid ? h.atLeast - paid : 0n } : h));
            return { message: build(held, limit, price), held, price };
        };
        // The site's own limit stays, with room for the guards. Otherwise the limit is what the transaction uses as it
        // will be signed, guards and fee settings included, measured with all the room a transaction may have, and a
        // tenth more. With guards, the account data a limited one loads is measured the same way. Measured with no
        // priority fee: it changes neither, and at the most units a fee could cost more than the wallet keeps.
        let limit = siteLimit !== null ? Math.min(MAX_COMPUTE_UNIT_LIMIT, siteLimit + added * GUARD_UNITS) : MAX_COMPUTE_UNIT_LIMIT;
        if (siteLimit === null || (roomed && added > 0)) {
            if (roomed) room = MAX_ROOM;
            const probe = await wired(unpriced(signable(MAX_COMPUTE_UNIT_LIMIT, false).message), r.signers);
            if (probe === null) return asIs("It's too full for Otus to lock it");
            const measured = await chain.simulate(probe.bytes, [], r.slot);
            if (measured.error !== null) return failed(measured.error, MAX_COMPUTE_UNIT_LIMIT);
            // An RPC that does not say what it used: the runtime's default for the site's instructions, and the guards'
            // room; v1 has no default, so the most there is.
            const unsaid = v1 ? MAX_COMPUTE_UNIT_LIMIT : defaultUnits(r.message) + added * GUARD_UNITS;
            const used = measured.unitsConsumed ? Number(measured.unitsConsumed) : null; // none at all is not said either
            if (siteLimit === null) limit = Math.min(MAX_COMPUTE_UNIT_LIMIT, used === null ? unsaid : Math.ceil(used * SPARE));
            if (roomed) room = roomFor(measured.loadedBytes ?? null, siteRoom);
        }
        market = await pricingAsked;
        if (signable(limit).message === r.message) return asIs('nothing of yours to hold');
        // As it will be signed, simulated once more. Short of units at the limit set (a run may use more than the last,
        // or a program act otherwise at another limit), it gets the most there is rather than losing its guards; left
        // without its rent by Otus's priority fee, it goes without that fee.
        const attempt = async (limit: number, priced: boolean) => {
            const { message, held, price } = signable(limit, priced);
            const prepared = await wired(message, r.signers);
            return prepared && { held, price, ...prepared, check: await chain.simulate(prepared.bytes, [], r.slot) };
        };
        let tried = await attempt(limit, true);
        if (tried?.check.error && spent(tried.check.error) && limit < MAX_COMPUTE_UNIT_LIMIT) tried = await attempt((limit = MAX_COMPUTE_UNIT_LIMIT), true);
        if (tried?.check.error && rentShort(tried.check.error) && tried.price > 0n) tried = await attempt(limit, false);
        if (tried === null) return asIs("It's too full for Otus to lock it");
        const { message, held, price, bytes, hash, check } = tried;
        if (check.error !== null) return failed(check.error, limit);
        const total = check.fee ?? fee(message);
        return { bytes, hash, fee: total, holds: held, unguarded: held.length > 0 ? null : (bare ?? 'nothing of yours to hold'), findings: [...feeFindings(r, wallet, total), ...differs(r, message, check)], units: limit, priced: price > 0n && market ? market.from : null, room: room !== siteRoom ? room : null, priority: price > 0n && market ? priorityFee(message) : null };
    } catch (cause) {
        console.error('Otus: preparing', cause);
        return asIs("The network didn't answer, so Otus couldn't lock it");
    }
}

// A failure of what Otus adds rather than of what the site's transaction does: one of the whole transaction (too
// many accounts, too much account data: no program can raise these), the fee payer left without its rent, or units
// run out where the guards' own could have done it (`units`: what the site's transaction used, the limit it had and
// the guards added). A guard failing, or a program that fails, or burns its units, only when it sees guards, is not.
function ours(error: NonNullable<Simulation['error']>, units: { used: bigint | null; limit: number; added: number }): boolean {
    if (typeof error === 'string') return true;
    if (rentShort(error)) return true;
    if (!spent(error)) return false;
    return !units.used || Number(units.used) + units.added * GUARD_UNITS + BUDGET_UNITS >= units.limit; // 0 is not said either
}

const spent = (error: NonNullable<Simulation['error']>) => typeof error === 'object' && 'InstructionError' in error && error.InstructionError[1] === 'ComputationalBudgetExceeded';
const rentShort = (error: NonNullable<Simulation['error']>) => typeof error === 'object' && 'InsufficientFundsForRent' in error && error.InsufficientFundsForRent.account_index === 0; // the fee payer, the only account whose lamports Otus changes

// The fee as prepared, where it is more than the review saw: Otus's guards add units at the site's own price.
function feeFindings(r: Review, wallet: Address, total: bigint): Finding[] {
    if (r.signers[0] !== wallet) return [];
    const reviewed = r.assessment.yours.fee;
    if (total > HUGE_FEE && reviewed <= HUGE_FEE) return [{ level: 'danger', code: 'high-fee', text: 'A huge network fee', note: 'It goes to whoever makes the block' }];
    if (total > HIGH_FEE && reviewed <= HIGH_FEE) return [{ level: 'warn', code: 'high-fee', text: 'High network fee' }];
    return [];
}

// No transaction needs Lighthouse or Compute Budget among the accounts it loads from a table: there they only keep
// Otus from adding its own, and so from guarding it.
const TABLED: Finding = { level: 'warn', code: 'blocks-guards', text: 'It keeps Otus from guarding it', note: 'It loads a program Otus adds from a lookup table' };

// The message with no priority fee: for legacy and v0, its price instruction at zero, in place or added.
function unpriced(m: Message): Message {
    if (m.version === 1) return m.config.priorityFeeLamports ? { ...m, config: { ...m.config, priorityFeeLamports: 0n } } : m;
    // A price instruction all the same, at zero: it uses the units the one set later will.
    return withBudget(m, SET_UNIT_PRICE, getSetComputeUnitPriceInstructionDataEncoder().encode({ microLamports: 0n }));
}

// Held to the simulated outcome it fails. If the site's own transaction still runs, it behaves differently when watched.
async function whyFailed(r: Review, chain: Chain): Promise<Finding> {
    const again = await chain.simulate(r.bytes, [], r.slot);
    return again.error === null
        ? { level: 'danger', code: 'guards-fail', text: 'It fails when held to what the simulation showed' }
        : { level: 'danger', code: 'simulation-failed', text: 'The transaction would fail now, so its effects cannot be seen' };
}

// The price of a unit, in micro-lamports: what the RPC recommends to write the same accounts, when it can (Helius, from
// the prices paid lately); otherwise what recent blocks took to write them, at the percentile. Both are asked at once,
// so an RPC without the recommendation costs no wait; what recent blocks took is needed only then.
async function pricing(r: Review, chain: Chain): Promise<{ price: bigint; from: Pricing }> {
    const writable = r.accounts.filter((a) => a.writable).map((a) => a.address).slice(0, FEE_ACCOUNTS);
    const [recommended, recent] = await Promise.allSettled([chain.recommended(writable), chain.fees(writable)]);
    if (recommended.status === 'fulfilled' && recommended.value !== null) return { price: recommended.value, from: 'recommended' };
    if (recent.status === 'rejected') throw recent.reason;
    const sorted = recent.value.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { price: sorted[Math.floor((sorted.length - 1) * PERCENTILE)] ?? 0n, from: 'recent' };
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

// Guarded, it may act otherwise than as the review saw it: a program Otus doesn't know calling, or being called,
// where it was not is what one does that knows it is watched. Known programs calling known ones otherwise is the chain
// moving on, as a fill through another market. It takes both simulations listing their calls to tell.
function differs(r: Review, guarded: Message, check: Simulation): Finding[] {
    if (!r.simulation.innerListed || !check.innerListed) return [];
    // Keyed by instruction: Otus's own are added after the site's, which keep their places.
    const pair = (c: { index: number; caller: Address; program: Address }) => `${c.index} ${c.caller} ${c.program}`;
    const seen = new Set(callsIn(r.simulation.inner, r.message.instructions.map((ix) => r.accounts[ix.programAddressIndex].address)).map(pair));
    const fresh = callsIn(check.inner, guarded.instructions.map((ix) => guarded.staticAccounts[ix.programAddressIndex]))
        .filter((c) => !seen.has(pair(c)) && !(PROGRAM_NAMES.has(c.caller) && PROGRAM_NAMES.has(c.program)));
    const programs = [...new Set(fresh.map((c) => c.program))].map((q) => PROGRAM_NAMES.get(q) ?? short(q));
    return programs.length ? [{ level: 'danger', code: 'guards-differ', text: 'It acts differently once guarded', note: `It then calls ${programs.join(', ')}, which the review did not see` }] : [];
}

// A message as the transaction's bytes, unsigned, and the hash of what is signed; null when it is too large to send.
async function wired(message: Message, signers: Address[]): Promise<{ message: Message; bytes: Uint8Array; hash: string } | null> {
    const signatures = Object.fromEntries(signers.map((a) => [a, null]));
    const bytes = new Uint8Array(getTransactionEncoder().encode({ messageBytes: encode(message), signatures }));
    return decode(bytes).then((d) => ({ message, bytes, hash: d.hash }), () => null);
}

function withAssertions(m: Message, h: Hold[], wallet: Address, accounts: Address[]): Message {
    if (h.length === 0) return m;
    const { message, at, shift } = withProgram(m, LIGHTHOUSE);
    const added = h.flatMap((x) => assertions(x, wallet).map((data) => ({ programAddressIndex: at, accountIndices: [shift(accounts.indexOf(x.account))], data })));
    return { ...message, instructions: [...message.instructions, ...added] };
}

// v1 keeps its budget in config; legacy and v0 in Compute Budget instructions. The priority fee of v1 is a total.
function withLimit(m: Message, units: number): Message {
    if (units === unitLimit(m)) return m;
    if (m.version === 1) return { ...m, config: { ...m.config, computeUnitLimit: units } };
    return withBudget(m, SET_UNIT_LIMIT, getSetComputeUnitLimitInstructionDataEncoder().encode({ units }));
}

function withPrice(m: Message, price: bigint): Message {
    if (price === 0n) return m;
    if (m.version === 1) return { ...m, config: { ...m.config, priorityFeeLamports: lamportsFor(price, unitLimit(m) ?? defaultUnits(m)) } };
    return withBudget(m, SET_UNIT_PRICE, getSetComputeUnitPriceInstructionDataEncoder().encode({ microLamports: price }));
}

// The account data a v1 transaction may load: what it loaded, guards included, and a tenth more, rounded up to the
// network's step; never below what the site set. An RPC that does not say: the most there is.
function roomFor(loaded: number | null, site: number | null): number {
    if (!loaded) return MAX_ROOM; // none at all is not said either: Lighthouse's own program is loaded
    return Math.min(MAX_ROOM, Math.max(site ?? 0, Math.ceil((loaded * SPARE) / ROOM_STEP) * ROOM_STEP));
}

// The account data a transaction may load: v1's in the message, legacy and v0's in the Compute Budget instruction that
// sets it, when there is one (without one, they may load the most there is).
function withRoom(m: Message, room: number | null): Message {
    if (room === null || dataLimit(m) === room) return m;
    if (m.version === 1) return { ...m, config: { ...m.config, loadedAccountsDataSizeLimit: room } };
    if (budgetIndex(m, SET_LOADED_DATA) < 0) return m;
    return withBudget(m, SET_LOADED_DATA, getSetLoadedAccountsDataSizeLimitInstructionDataEncoder().encode({ accountDataSizeLimit: room }));
}

// Its Compute Budget instructions first, after a durable nonce's advance, which stays first: a Ledger's Solana app reads
// a transaction in clear only so, and shows one with them last as a hash.
function budgetFirst(m: Message): Message {
    const budget = (ix: Message['instructions'][number]) => m.staticAccounts[ix.programAddressIndex] === COMPUTE_BUDGET_PROGRAM_ADDRESS;
    const lead = durable(m) ? 1 : 0;
    const rest = m.instructions.slice(lead);
    return { ...m, instructions: [...m.instructions.slice(0, lead), ...rest.filter(budget), ...rest.filter((ix) => !budget(ix))] };
}

// Replaces the Compute Budget instruction of this kind, or adds one at the end, where it keeps a durable nonce first.
function withBudget(m: Message, which: typeof SET_UNIT_LIMIT, data: ReadonlyUint8Array): Message {
    const i = budgetIndex(m, which);
    if (i >= 0) return { ...m, instructions: m.instructions.map((ix, j) => (j === i ? { ...ix, data } : ix)) };
    const { message, at } = withProgram(m, COMPUTE_BUDGET_PROGRAM_ADDRESS);
    return { ...message, instructions: [...message.instructions, { programAddressIndex: at, accountIndices: [], data }] };
}

// Adds a program as the last read-only static account, unless it is one already. Accounts loaded from tables move one place.
function withProgram(m: Message, program: Address): { message: Message; at: number; shift: (i: number) => number } {
    const found = m.staticAccounts.indexOf(program);
    if (found >= 0) return { message: m, at: found, shift: (i) => i };
    const at = m.staticAccounts.length;
    const shift = (i: number) => (i >= at ? i + 1 : i);
    const message = {
        ...m,
        header: { ...m.header, numReadonlyNonSignerAccounts: m.header.numReadonlyNonSignerAccounts + 1 },
        staticAccounts: [...m.staticAccounts, program],
        instructions: m.instructions.map((ix) => ({ ...ix, accountIndices: ix.accountIndices.map(shift) })),
    };
    return { message, at, shift };
}

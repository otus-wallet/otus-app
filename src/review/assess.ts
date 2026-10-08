import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import {
    address,
    getAddressDecoder,
    getAddressEncoder,
    getI64Decoder,
    getU32Decoder,
    getU64Decoder,
    isOffCurveAddress,
    type Address,
    type ReadonlyUint8Array,
} from '@solana/kit';

import { short } from '../format.ts';
import { STAKE_PROGRAM, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAMS } from '../programs/addresses.ts';
import { BRANDS, HOLDS, PROGRAM_NAMES } from '../programs/known.ts';
import { holdings, offsetsOf, plain, read, units, type Change, type Changes, type State } from './changes.ts';
import { durable } from './decode.ts';
import type { Explained } from './explain.ts';
import type { Deployment } from './programs.ts';
import { lookalike } from './sites.ts';
import type { Simulated } from './simulate.ts';

/** How much a finding matters. A notice is worth knowing and changes nothing: the verdict is the worst of the rest. */
export type Level = 'ok' | 'notice' | 'warn' | 'danger';
/** A colour a line gets: a level, or plain text. */
export type Tone = Level | 'plain';
export type Verdict = 'ok' | 'warn' | 'danger';
/** `programs`: the programs it is about besides its subject, as the channel of what it says. */
export type Finding = { level: Level; code: string; text: string; note?: string; subject?: Address; programs?: Address[] };

/** What the wallet knows that the transaction does not say. */
export type Context = {
    wallet: Address; // the account asked to sign
    signedBefore: number | null; // when you first signed a transaction for this site, in seconds since 1970; null: never
    host?: string; // the site's, to tell one that imitates a known site
    now?: number; // seconds since 1970, to tell how long ago a program was deployed
    deployments?: Map<Address, Deployment>;
    own?: boolean; // made in Otus itself: no site asked for it
    to?: Address; // for a transfer made in Otus: the address typed
    wallets?: Address[]; // every account of yours in Otus, watched ones too: what lands with them, or in their token accounts, is yours
    contacts?: Map<Address, string>; // the addresses you keep, by your names for them
};

/** What one program gets from you. `name`: Otus's, for a program it knows; null for one it doesn't. `accounts`: how
 *  many of yours it can write. `unseen`: it has your signature where the RPC did not list what it calls. */
export type ProgramUse = { program: Address; name: string | null; signature: boolean; writable: boolean; accounts: number; unseen: boolean };

/** One asset of yours that moves: your net change, the fee aside, and the accounts on the other side, biggest first.
 *  `holder`: who holds that side (a token account's owner, or the account itself); `wallet`: a key someone holds. */
export type Flow = { asset: 'SOL' | Address; change: bigint; others: { address: Address; holder: Address; amount: bigint; wallet: boolean }[] };

/** Value that lands with someone else in a transaction you sign, beyond what left your accounts: out of a program's
 *  custody (a lending pool's vault, say) to a wallet that is not one of yours, nor holds a token account of yours; or,
 *  when nothing comes back to you, to a program's accounts. `known`: your name for that wallet, when you keep it;
 *  `programs`: those whose instructions name where it lands. */
export type Payout = { holder: Address; known: string | null; program: boolean; amounts: { asset: 'SOL' | Address; amount: bigint }[]; programs: Address[] };

/** What an account of the transaction is. */
export type Kind = 'you' | 'your-tokens' | 'yours' | 'programs' | 'mints' | 'tokens' | 'wallets' | 'program-accounts' | 'sysvars' | 'new';

export type Assessment = {
    verdict: Verdict; // the worst finding, notices aside
    findings: Finding[]; // worst first
    mine: Set<Address>; // the accounts that are yours: the wallet, token accounts it owns, accounts only it can withdraw from
    yours: Changes; // your fee (0 when another account pays) and the accounts of yours it can write: what guards hold
    keyed: Change[]; // other accounts it can write with your address in them: not yours, but guarded so your place stays
    programs: ProgramUse[];
    flows: Flow[];
    payouts: Payout[];
    kinds: Map<Address, Kind>;
};

export const HIGH_FEE = 5_000_000n; // lamports
export const HUGE_FEE = 50_000_000n; // lamports: no transaction needs this much
const U64_MAX = 2n ** 64n - 1n; // an allowance without end
const ORDER: Record<Level, number> = { danger: 0, warn: 1, notice: 2, ok: 3 };
const [HOUR, DAY] = [3_600, 86_400];
const FRESH = 7 * DAY; // a program deployed this recently gets a word
const RENT_BACK = 10_000_000n; // lamports: SOL this small landing with someone else is rent given back to whoever paid it
const SLOTS_PER_EPOCH = 432_000n;
type Clock = { now: number | null; epoch: bigint };

/** The earlier steps' output → findings, verdict, your changes, flows, and what each program gets from you. Pure. */
export function assess(s: Simulated, changes: Changes, explained: Explained[], context: Context): Assessment {
    const { wallet } = context;
    const key = getAddressEncoder().encode(wallet);
    // When it is, for a stake lockup: the time, and the epoch from the slot (432,000 slots each; where early epochs were
    // shorter, this reads one below the true epoch, so a lockup counts a little longer, never shorter).
    const clock: Clock = { now: context.now ?? null, epoch: s.slot / SLOTS_PER_EPOCH };
    const mine = yourAccounts(s, changes, wallet, clock);
    const yours: Changes = { fee: s.signers[0] === wallet ? changes.fee : 0n, accounts: changes.accounts.filter((c) => mine.has(c.address)) };
    // Your address inside an account does not make it yours: anyone can write it into theirs.
    const keyed = changes.accounts.filter((c) => !mine.has(c.address) && (holds(c.before, key) || holds(c.after, key)));
    const programs = programUses(s, explained, mine, context);
    const flows = flowsOf(changes, yours, mine);
    const findings: Finding[] = [];
    const add = (level: Level, code: string, text: string, subject?: Address, note?: string) =>
        findings.push({ level, code, text, ...(note !== undefined && { note }), ...(subject !== undefined && { subject }) });

    // What the simulation shows. A failed one shows nothing, and a site can make it fail on purpose.
    const failed = s.simulation.error !== null;
    if (failed) add('danger', 'simulation-failed', 'The transaction would fail now, so its effects cannot be seen', undefined, 'A site can make it fail on purpose, to hide what it does');
    else add('ok', 'simulated', 'Changes');
    const shown = findings.length;
    for (const { address, before, after } of [...yours.accounts, ...keyed]) {
        const [from, to] = [before?.token ?? null, after?.token ?? null];
        if (address === wallet) {
            if (after && !plain(after)) add('danger', 'wallet-change', 'Your wallet would no longer be a plain wallet', address, `A program takes it over: ${name(after.program)}`);
        } else if (before && after && !plain(before) && before.program !== after.program) {
            if (mine.has(address)) add('danger', 'owner-change', 'An account of yours changes owner', address, `New owner ${name(after.program)}. You lose control of it.`);
            else add('danger', 'owner-change', 'An account with your address in it changes owner', address, `New owner ${name(after.program)}. Your place in it may go.`);
        }
        if (from && to && from.owner !== to.owner) add('danger', 'token-owner-change', 'A token account of yours changes owner', address, `New owner ${to.owner}. You lose control of it.`);
        if (to?.delegate && (to.delegate !== from?.delegate || to.delegated > (from?.delegated ?? 0n))) {
            // Someone's key allowed all the account holds, or without end, takes all of it whenever it likes; a
            // program's own address, as a marketplace's, only as its program lets it.
            const all = !isOffCurveAddress(to.delegate) && (to.delegated === U64_MAX || (to.amount > 0n && to.delegated >= to.amount));
            if (all) add('danger', 'delegate', 'Someone could take all the tokens in an account of yours', address, `${to.delegate} could move them at any time`);
            else add('warn', 'delegate', 'A token account of yours gets a delegate, or a bigger allowance', address, `${to.delegate} could move its tokens`);
        }
        if (to?.closer && to.closer !== from?.closer) {
            // Closing a wrapped SOL account sends all its SOL where the closer says; any other, only its rent.
            if (to.native && to.closer !== wallet) add('danger', 'close-authority', 'Someone could take the SOL in your wrapped SOL account', address, `${to.closer} could close it and take its SOL at any time`);
            else add('warn', 'close-authority', 'A token account of yours gets a new close authority', address, `${to.closer} could close it`);
        }
        // Your stake under a lockup in force that someone else keeps: made so now, or getting your SOL, as into a stake
        // account made for you beforehand. You can't withdraw until it ends, or they lift it.
        const [was, is] = [stake(before, clock), stake(after, clock)];
        const kept = is !== null && is.locked && is.custodian !== wallet && (was ?? is).withdrawer === wallet;
        const fed = (after?.lamports ?? 0n) > (before?.lamports ?? 0n);
        if (kept && (is.lockup !== was?.lockup || fed)) {
            const text = is.lockup === was?.lockup ? 'Your SOL goes into stake someone else keeps locked' : 'Your stake gets a lockup someone else holds';
            add('danger', 'stake-lockup', text, address, is.custodian === SYSTEM_PROGRAM_ADDRESS ? "No one can lift it: you can't withdraw until it ends" : `${is.custodian} can lift it: until then you can't withdraw`);
        }
        // Your address inside any other account, as its authority or owner, stays where it was.
        if (before && after && !from) {
            for (const offset of offsetsOf(key, before).filter((o) => !offsetsOf(key, after).includes(o))) {
                const role = roleAt(before, offset);
                if (role) add('danger', 'authority-change', `You would lose your ${role}`, address);
                else add('warn', 'authority-change', 'Your address would leave an account that held it, maybe as its authority', address);
            }
        }
    }
    // An upgrade authority of yours used: new code for your program, or its program data closed, ending it for good.
    for (const [program, text] of upgrades(s, wallet)) add('danger', 'program-change', text, program, 'Signed with your upgrade authority');
    if (!failed && findings.length === shown) add('ok', 'no-authority-change', 'No owner or authority changes', undefined, 'Owners and authorities stay as they are');
    if (!failed) for (const [what, subject] of outflows(yours)) add('warn', 'large-outflow', `You send almost all ${what}`, subject);

    // What the message asks for.
    if (durable(s.message)) add('danger', 'durable-nonce', 'Durable nonce: this transaction never expires', undefined, 'It can be kept and sent at any time later');
    if (yours.fee > HUGE_FEE) add('danger', 'high-fee', 'A huge network fee', undefined, 'It goes to whoever makes the block');
    else if (yours.fee > HIGH_FEE) add('warn', 'high-fee', 'High network fee');
    else if (yours.fee > 0n) add('ok', 'normal-fee', 'Normal network fee');

    // Who gets what from you. A program Otus doesn't know gets a word: a warning when it gets your signature or
    // accounts, a notice otherwise (a notice too once its own IDL describes it: see described). It is critical only
    // for what it does: taking your signature into a program that keeps something of yours no balance shows, or where
    // Otus cannot see.
    for (const p of programs) {
        const named = p.name ?? 'An unknown program';
        const getsYou = p.signature || p.writable;
        if (p.name === null) {
            const what = p.accounts > 0 ? `It uses ${p.accounts} of your accounts` : 'It uses your signature';
            add(getsYou ? 'warn' : 'notice', 'unknown-program', `${short(p.program)} is not a program Otus knows`, p.program, getsYou ? what : 'It touches nothing of yours');
            if (p.unseen) add('danger', 'reach-unseen', "Otus can't see what an unknown program does with your signature", p.program, 'The RPC did not list what it calls');
        }
        const d = context.deployments?.get(p.program);
        const age = d?.deployed && context.now ? Math.max(0, context.now - d.deployed) : null;
        // Known programs redeploy often; a fresh one only counts for a program no one can name.
        if (d && age !== null && age < FRESH && !d.builtin && p.name === null) {
            add(age < DAY && getsYou && p.name === null ? 'danger' : 'warn', 'fresh-program', `${named} was deployed ${ago(age)}`, p.program, d.upgradeable ? 'Its authority can still change it' : 'It can no longer change');
        }
    }
    // Where your signature reaches: a program Otus doesn't know calling one that keeps something of yours, at any depth;
    // or given it beside one, which it can call once it lands, whatever it did when simulated.
    const reached = holdsCalls(s, wallet);
    const where = (held: Set<Address>) => [...held].map((q) => PROGRAM_NAMES.get(q)).join(', ');
    for (const [caller, held] of reached) add('danger', 'reaches-holdings', `An unknown program uses your signature in ${where(held)}`, caller, HOLDINGS);
    const seen = new Set([...reached.values()].flatMap((held) => [...held]));
    for (const [caller, held] of holdsBeside(s, wallet)) {
        const fresh = new Set([...held].filter((q) => !seen.has(q)));
        if (fresh.size) add('danger', 'reaches-holdings', `An unknown program can use your signature in ${where(fresh)}`, caller, HOLDINGS);
    }
    if (programs.length > 0 && programs.every((p) => p.name !== null)) add('ok', 'all-known', 'Known programs', undefined, programs.map((p) => p.name).join(', '));

    if (!failed) findings.push(...leaving(programs, explained, changes, flows, yours, nftBack(s, changes, key)));

    // Value that lands with someone else without leaving your accounts: said exactly, for you to judge. To an address
    // you keep, by its name.
    const payouts = failed ? [] : payoutsOf(s, changes, mine, yours, flows, context);
    for (const p of payouts) {
        const [level, code, text]: [Level, string, string] = p.known ? ['notice', 'pays-known', `Funds go to ${p.known}`] : ['warn', 'pays-others', p.program ? "Funds go to a program's account, not to you" : 'Funds go to someone else, not to you'];
        findings.push({ level, code, text, subject: p.holder, programs: p.programs });
    }

    // Where the request comes from. A site becomes known a day after its first transaction you signed: a site can ask
    // for a harmless one first, but a scam rarely waits a day.
    const kinds = kindsOf(s, changes, mine, wallet);
    if (context.own) {
        add('ok', 'own-transfer', 'Made in Otus', undefined, 'No site asked for it');
        // Typed to a program's account, or to an address no key can hold: what goes there may not come back.
        const to = context.to;
        const kind = to ? kinds.get(to) : undefined;
        if (to && (kind === 'program-accounts' || kind === 'programs' || kind === 'mints' || (kind === 'new' && isOffCurveAddress(to)))) add('warn', 'to-program', 'You send to a program’s account', to, 'Not to someone with a key: what you send may not come back');
    } else {
        const imitated = context.host ? lookalike(context.host) : null;
        if (imitated) add('warn', 'lookalike', `This site looks like ${imitated}`, undefined, `${context.host} is not ${imitated}`);
        const since = context.signedBefore;
        const age = since !== null && context.now !== undefined ? Math.max(0, context.now - since) : null;
        if (since === null) add('warn', 'first-visit', 'First transaction for this site', undefined, 'You never signed one for it from this wallet');
        else if (age !== null && age < DAY) add('notice', 'new-site', 'New site', undefined, `You first signed a transaction for it ${ago(age)}`);
        else add('ok', 'known-site', 'Known site', undefined, context.host ? `${context.host} · signed for before` : undefined);
    }

    return { ...ranked(findings), mine, yours, keyed, programs, flows, payouts, kinds };
}

/**
 * The findings once the IDLs of the programs Otus doesn't know are read. `described`: each such program whose own
 * IDL tells every instruction of it here, by the name it gives itself. Described, it is shown for what it says it is,
 * by that name: a notice, while guards hold what it does with you (`held`: they are on, and Otus sends it now). An IDL
 * names instructions and binds nothing: unguarded, or sent later by the site, a program that gets you stays a warning.
 * One that is not described stays as it was, and says so. One whose name borrows the brand of a program Otus knows is
 * critical when it gets you: what a site does to pass a program off as another.
 */
export function described(findings: Finding[], named: Map<Address, string>, programs: ProgramUse[], held = true): Finding[] {
    const told = findings.map((f): Finding => {
        if (f.code !== 'unknown-program' || !f.subject) return f;
        const name = named.get(f.subject);
        if (!name) return { ...f, note: `${f.note} · Otus can't read what it does` };
        return { ...f, level: f.level === 'warn' && !held ? 'warn' : 'notice', text: `${name} is not a program Otus knows`, note: `${f.note} · its own IDL describes it` };
    });
    const posing = programs.flatMap((p): Finding[] => {
        const name = named.get(p.program);
        const brand = name && p.name === null ? borrowed(name) : null;
        const core = name && p.name === null && !brand ? posingAs(name) : null; // a plain word, as a crate may be called
        if (!name || !(brand || core)) return [];
        const level = brand && (p.signature || p.writable) ? 'danger' : 'warn';
        return [{ level, code: 'imitation-program', text: `An unknown program calls itself ${name}`, subject: p.program, note: `It is not the ${brand ?? core} program Otus knows: ${short(p.program)}` }];
    });
    return [...told, ...posing];
}

// A name's words, lowercase: "jupiterAggregator_v2" → jupiter, aggregator, v2; "OKXRouter" → okx, router.
const words = (name: string) =>
    name.normalize('NFKC').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// What a program Otus doesn't know may borrow to pass for another: the brands, the wallets', and the names of the
// programs every transaction uses. Matched by whole words, so "Python" is not Pyth. Words as plain as Memo or Vote,
// and names forks keep, as SPL Governance's or a stake pool's, are no borrowing.
const BORROWABLE: ReadonlySet<string> = new Set([
    ...BRANDS,
    ...['otus', 'phantom', 'solflare', 'backpack'],
    ...['systemprogram', 'tokenprogram', 'token2022', 'associatedtoken', 'computebudget', 'stakeprogram', 'voteprogram', 'addresslookuptable'],
]);

// What a brand comes with in one word of a product's name: "jupiterv6", "kaminolend", "raydiumamm", "orcawhirlpool"
// (another brand), "realjupiter".
const PRODUCT = /^(?:v?\d+|swap|amm|clmm|cpmm|dlmm|router|route|lend|lending|aggregator|agg|perps?|dex|pools?|vaults?|farms?|stake|staking|bridge|program|protocol|finance|fi|labs|exchange|markets?|network|oracle|wallet|official|app|pro|io|xyz|sol)*$/;
const BEFORE = /^(?:the|real|official|my|true|get|go|super)/;

// The brand a word is made of, as a product of it; null when it is another word ("python" is no Pyth).
function brandIn(word: string, depth = 0): string | null {
    if (BORROWABLE.has(word)) return word;
    for (const b of BORROWABLE) if (word.startsWith(b) && (PRODUCT.test(word.slice(b.length)) || (depth === 0 && brandIn(word.slice(b.length), 1)))) return b;
    return null;
}

// A name, whole, that one of Solana's own programs goes by: "System", "Token", "Upgradeable Loader". Only whole:
// "token_vesting" or "stake_pool_router" borrow nothing, nor the names forks keep, as SPL Governance's.
const fold = (name: string) => words(name).join('');
const OWN_NAMES = new Map<string, string>(
    ['System', 'System Program', 'Token', 'Token Program', 'SPL Token', 'Token 2022', 'Stake', 'Stake Program', 'Memo', 'Vote', 'Vote Program', 'Loader', 'BPF Loader', 'Native Loader', 'Upgradeable Loader', 'Wrapped SOL', 'Compute Budget', 'Associated Token'].map((n): [string, string] => [fold(n), n]),
);
const posingAs = (name: string) => OWN_NAMES.get(fold(name)) ?? null;

// Digits that pass for letters: "jup1ter", "kam1n0".
const unleet = (word: string) => word.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't');

// The name a program borrows: a brand its words spell in a row, or one a word is a product of, as written or with its
// digits read as letters, after a word such as "real" or "official".
function borrowed(name: string): string | null {
    const w = words(name);
    for (let i = 0; i < w.length; i++) for (let j = i + 1; j <= w.length; j++) if (BORROWABLE.has(w.slice(i, j).join(''))) return w.slice(i, j).join('');
    for (const word of w.flatMap((x) => [x, unleet(x)])) {
        const found = brandIn(word) ?? brandIn(word.replace(BEFORE, ''));
        if (found) return found;
    }
    return null;
}

/** Findings worst first, and the verdict: the worst of them, notices aside. */
export function ranked(findings: Finding[]): { verdict: Verdict; findings: Finding[] } {
    const sorted = findings.toSorted((a, b) => ORDER[a.level] - ORDER[b.level]);
    const worst = sorted[0]?.level;
    return { verdict: worst === 'danger' || worst === 'warn' ? worst : 'ok', findings: sorted };
}

/** How long ago, in words: "40 minutes ago", "3 hours ago", "2 days ago". */
export function ago(seconds: number): string {
    const [n, unit] = seconds < HOUR ? [Math.max(1, Math.round(seconds / 60)), 'minute'] : seconds < DAY ? [Math.round(seconds / HOUR), 'hour'] : [Math.round(seconds / DAY), 'day'];
    return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

// Yours: your wallet, every token account it owns before or after, and the accounts whose SOL only you can take out.
function yourAccounts(s: Simulated, changes: Changes, wallet: Address, clock: Clock): Set<Address> {
    const owned = (state: State) => state?.token?.owner === wallet || withdrawer(state, clock) === wallet;
    const before = s.accounts.filter((a) => owned(read(a.state))).map((a) => a.address);
    const after = changes.accounts.filter((c) => owned(c.after)).map((c) => c.address);
    return new Set([wallet, ...before, ...after]);
}

// Who can take the SOL out of an account other than a token account: a nonce account's authority, or a stake account's
// withdrawer, unless a lockup someone else keeps holds it.
function withdrawer(state: State, clock: Clock): Address | null {
    if (!state || state.token) return null;
    const d = state.data;
    const at = (offset: number) => getAddressDecoder().decode(d, offset);
    // A nonce account: version, state (1: initialized), authority, nonce, fee.
    if (state.program === SYSTEM_PROGRAM_ADDRESS && state.space === 80 && getU32Decoder().decode(d, 4) === 1) return at(8);
    // A stake account: its withdrawer's, unless a lockup someone else can lift holds it.
    const k = stake(state, clock);
    if (k) return k.locked && k.custodian !== k.withdrawer ? null : k.withdrawer;
    return null;
}

// A stake account, kind 1 (initialized) or 2 (delegated): its withdrawer, and its lockup (a time, an epoch, and the
// custodian who alone can lift it before then), in force while its time or its epoch is still ahead, as the Stake
// program reads it; with no clock, or no time known, whenever it has one. Its data: kind, rent reserve, staker,
// withdrawer, time, epoch, custodian.
function stake(state: State, clock?: Clock): { withdrawer: Address; custodian: Address; locked: boolean; lockup: string } | null {
    if (!state || state.token || state.program !== STAKE_PROGRAM || state.data.length < 124 || ![1, 2].includes(getU32Decoder().decode(state.data, 0))) return null;
    const d = state.data;
    const [time, epoch, custodian] = [getI64Decoder().decode(d, 76), getU64Decoder().decode(d, 84), getAddressDecoder().decode(d, 92)];
    const ahead = (clock?.now ?? null) === null ? time !== 0n : time > BigInt(clock!.now!);
    return { withdrawer: getAddressDecoder().decode(d, 44), custodian, locked: ahead || epoch > (clock?.epoch ?? 0n), lockup: `${time}:${epoch}:${custodian}` };
}

/** The calls made inside a transaction's instructions (`tops`: each one's program), each with its caller, the latest
 *  call one level up (the instruction's own program at the top), and every program above it. Where the RPC gives no
 *  depth, the caller is taken as the instruction's program, and any program before the call as above it. */
export function callsIn(inner: Simulated['simulation']['inner'], tops: Address[]): { index: number; program: Address; caller: Address; above: Address[] }[] {
    return inner.flatMap((group) => {
        const top = tops[group.index];
        if (!top) return [];
        const line: Address[] = [top]; // the program at each depth, the top at depth 1
        const before: Address[] = [top];
        return group.calls.map((call) => {
            const depth = call.depth && call.depth >= 2 ? call.depth : null;
            const caller = depth ? (line[depth - 2] ?? top) : top;
            const above = depth ? line.slice(0, depth - 1) : [...before];
            if (depth) line.splice(depth - 1, line.length, call.program);
            before.push(call.program);
            return { index: group.index, program: call.program, caller, above };
        });
    });
}

// Programs Otus doesn't know above a call to one which keeps something of yours (HOLDS), under an instruction you
// sign, at any depth: the nearest of them, with what it reached.
function holdsCalls(s: Simulated, wallet: Address): Map<Address, Set<Address>> {
    const signed = new Set(s.message.instructions.flatMap((ix, i) => (ix.accountIndices.some((j) => s.accounts[j].address === wallet && s.accounts[j].signer) ? [i] : [])));
    const found = new Map<Address, Set<Address>>();
    for (const { index, program, above } of callsIn(s.simulation.inner, s.message.instructions.map((ix) => s.accounts[ix.programAddressIndex].address))) {
        const unknown = above.findLast((q) => q !== program && !PROGRAM_NAMES.has(q));
        if (signed.has(index) && REACHABLE.has(program) && unknown) found.set(unknown, new Set([...(found.get(unknown) ?? []), program]));
    }
    return found;
}

// Programs Otus doesn't know given your signature in an instruction that also names a program which keeps something of
// yours (HOLDS). A program can call another only when the instruction it runs in names that one: so it can when it
// lands, whatever the simulation saw it do, as a program may act otherwise then.
function holdsBeside(s: Simulated, wallet: Address): Map<Address, Set<Address>> {
    const found = new Map<Address, Set<Address>>();
    for (const ix of s.message.instructions) {
        const program = s.accounts[ix.programAddressIndex].address;
        const named = ix.accountIndices.map((j) => s.accounts[j]);
        if (PROGRAM_NAMES.has(program) || !named.some((a) => a.address === wallet && a.signer)) continue;
        const held = named.filter((a) => REACHABLE.has(a.address)).map((a) => a.address);
        if (held.length) found.set(program, new Set([...(found.get(program) ?? []), ...held]));
    }
    return found;
}

const HOLDINGS = 'Where it could touch loans, stakes, votes or programs of yours, which no balance shows';

// What a program Otus doesn't know must not reach with your signature: the programs that keep something of yours where
// no balance shows it, and the Upgradeable Loader, where your signature may be a program's upgrade authority.
const UPGRADEABLE_LOADER_ADDRESS = address('BPFLoaderUpgradeab1e11111111111111111111111');
const REACHABLE: ReadonlySet<Address> = new Set([...HOLDS, UPGRADEABLE_LOADER_ADDRESS]);

// What the Upgradeable Loader is asked to do with your signature as a program's upgrade authority: Upgrade (its 7th
// account), or Close of a program data account (its 3rd), which ends the program for good; a buffer closed is only
// its rent back. A program data account's kind is 3.
function upgrades(s: Simulated, wallet: Address): [Address, string][] {
    return s.message.instructions.flatMap((ix): [Address, string][] => {
        if (s.accounts[ix.programAddressIndex].address !== UPGRADEABLE_LOADER || ix.data.length < 4) return [];
        const at = (i: number) => (ix.accountIndices[i] === undefined ? undefined : s.accounts[ix.accountIndices[i]]);
        const signs = (i: number) => at(i)?.address === wallet && at(i)?.signer === true;
        const kind = getU32Decoder().decode(ix.data, 0);
        if (kind === 3 && signs(6)) return [[at(1)?.address ?? at(0)!.address, 'Your program gets new code']];
        const closed = at(0) ? read(at(0)!.state) : null;
        const data = closed?.program === UPGRADEABLE_LOADER && closed.data.length >= 4 && getU32Decoder().decode(closed.data, 0) === 3;
        if (kind === 5 && signs(2) && data) return [[at(3)?.address ?? at(0)!.address, 'Your program is closed for good']];
        return [];
    });
}

// An account other than a token account with your address in its data: you may be its authority, or anyone put it there.
const holds = (state: State, key: ReadonlyUint8Array) => state !== null && state.token === null && offsetsOf(key, state).length > 0;

// What instructions Otus reads send to each account, in words the user sees: SOL by the System Program, tokens by
// the Token Programs, and the SOL of an account they close. Keyed "SOL:<address>" and "token:<address>".
function sentInWords(explained: Explained[], changes: Changes): Map<string, bigint> {
    const sent = new Map<string, bigint>();
    const add = (key: string, amount: bigint) => sent.set(key, (sent.get(key) ?? 0n) + amount);
    const lamports = new Map(changes.accounts.map((c) => [c.address, c.before?.lamports ?? 0n]));
    for (const e of explained) {
        if (e.source === 'unknown') continue;
        const arg = (name: string) => {
            const v = e.args.find((a) => a.name === name)?.value ?? '';
            return /^\d+$/.test(v) ? BigInt(v) : 0n;
        };
        const to = (role: string) => e.accounts.find((a) => a.role === role)?.address;
        const pair = (kind: string, role: string, amount: bigint) => {
            const a = to(role);
            if (a) add(`${kind}:${a}`, amount);
        };
        if (e.program === SYSTEM_PROGRAM_ADDRESS) {
            if (e.name === 'TransferSol' || e.name === 'TransferSolWithSeed') pair('SOL', 'destination', arg('amount'));
            else if (e.name === 'CreateAccount' || e.name === 'CreateAccountWithSeed') pair('SOL', 'newAccount', arg('lamports'));
            else if (e.name === 'WithdrawNonceAccount') pair('SOL', 'recipientAccount', arg('withdrawAmount'));
        } else if (TOKEN_PROGRAMS.includes(e.program)) {
            if (e.name === 'Transfer' || e.name === 'TransferChecked') pair('token', 'destination', arg('amount'));
            else if (e.name === 'CloseAccount') {
                const closed = to('account');
                if (closed) pair('SOL', 'destination', lamports.get(closed) ?? 0n);
            }
        }
    }
    return sent;
}

const name = (program: Address) => PROGRAM_NAMES.get(program) ?? program;
const UPGRADEABLE_LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');

/** Solana's sysvars, by their exact addresses: a wallet's address can start with "Sysvar" too. */
export const SYSVARS: ReadonlySet<Address> = new Set(
    [
        'SysvarC1ock11111111111111111111111111111111',
        'SysvarEpochRewards1111111111111111111111111',
        'SysvarEpochSchedu1e111111111111111111111111',
        'Sysvar1nstructions1111111111111111111111111',
        'SysvarLastRestartS1ot1111111111111111111111',
        'SysvarRecentB1ockHashes11111111111111111111',
        'SysvarRent111111111111111111111111111111111',
        'SysvarS1otHashes111111111111111111111111111',
        'SysvarS1otHistory11111111111111111111111111',
        'SysvarStakeHistory1111111111111111111111111',
        'SysvarFees111111111111111111111111111111111',
        'SysvarRewards111111111111111111111111111111',
    ].map((a) => address(a)),
);

/** A mint: 82 bytes, or a Token-2022 mint with extensions, marked 1 after the room a token account takes. */
export const isMint = (s: NonNullable<State>) => TOKEN_PROGRAMS.includes(s.program) && (s.space === 82 || (s.program === TOKEN_2022_PROGRAM_ADDRESS && s.space > 165 && s.space !== 355 && s.data[165] === 1));

// The role of an address at this offset, where well-known programs keep one.
function roleAt(s: NonNullable<State>, offset: number): string | null {
    const token = TOKEN_PROGRAMS.includes(s.program);
    if (isMint(s)) return offset === 4 ? 'mint authority' : offset === 50 ? 'freeze authority' : offset > 165 ? 'authority in a Token-2022 mint' : null;
    if (token && s.space === 355) return 'place among a token multisig signers';
    if (s.program === SYSTEM_PROGRAM_ADDRESS && s.space === 80 && offset === 8) return 'nonce authority';
    if (s.program === STAKE_PROGRAM) return ({ 12: 'stake authority', 44: 'withdraw authority', 92: 'stake lockup custodian' } as Record<number, string>)[offset] ?? null;
    if (s.program === UPGRADEABLE_LOADER && offset === 13) return 'program upgrade authority';
    return null;
}

// Your assets going to someone else in a way Otus cannot read in words: what a drainer does (what an instruction
// Otus reads sends is shown in words, so that much counts as seen). Through a program Otus doesn't know, whoever
// receives counts, its own accounts included; through programs it knows, a wallet (their own accounts are where
// deposits go). Something coming back to you makes it a trade: through programs Otus knows, nothing to say; through
// one it doesn't, worth checking, never critical. Nothing coming back: to a wallet, critical unless a small share, as a
// fee is; into a program's accounts, a warning, critical when it takes almost all of one of your assets.
function leaving(programs: ProgramUse[], explained: Explained[], changes: Changes, flows: Flow[], yours: Changes, nft: boolean): Finding[] {
    const blind = programs.filter((p) => (p.signature || p.writable) && explained.some((e) => e.program === p.program && e.source === 'unknown'));
    const strange = blind.some((p) => p.name === null);
    const seen = sentInWords(explained, changes);
    const hidden = flows.flatMap((f) => (f.change < 0n ? f.others.filter((o) => (o.wallet || strange) && o.amount > (seen.get(`${f.asset === 'SOL' ? 'SOL' : 'token'}:${o.address}`) ?? 0n)).map((o) => ({ f, o })) : []));
    if (!blind.length || !hidden.length) return [];
    const by = blind.map((p) => p.name ?? 'an unknown program').join(', ');
    const subject = hidden[0].o.holder;
    if (nft || flows.some((f) => f.change > 0n)) return strange ? [{ level: 'warn', code: 'check-balances', text: 'Check the balances', subject, note: `A trade through ${by}, which Otus cannot read`, programs: blind.filter((p) => p.name === null).map((p) => p.program) }] : [];
    const swept = new Set<string>(outflows(yours).map(([, mint]) => mint ?? 'SOL'));
    const small = hidden.every(({ f, o }) => o.amount * 20n <= -f.change);
    const critical = hidden.some(({ f, o }) => (o.wallet ? o.amount * 20n > -f.change : swept.has(f.asset)));
    const assets = new Set(hidden.map(({ f }) => f.asset)).size;
    const text = small ? 'A small part of your assets goes to someone else' : assets === 1 ? 'An asset of yours goes to someone else' : `${assets} of your assets go to someone else`;
    return [{ level: critical ? 'danger' : 'warn', code: 'sends-to-wallet', text, subject, note: `Through ${by}, which Otus cannot read${small ? ': a fee, maybe' : ''}`, programs: (strange ? blind.filter((p) => p.name === null) : blind).map((p) => p.program) }];
}

// What lands with someone else (not your accounts in Otus, nor token accounts any of them owns, ATA or not), by asset,
// beyond what left your accounts in it: from a program's custody, then. With a wallet, always counted. With a program's
// accounts, only one that gives nothing here (a pool, or a protocol trading for you, both gives and takes), and only as
// much as custody released: a vault that got nothing back paying out (your position withdrawn elsewhere), or, when you
// paid and nothing came back, any (what your trade buys, sent elsewhere). Each part on its own: a twentieth or less of
// what comes to you in the same asset is a fee; SOL this small, rent given back. Shared out to those that got most first.
function payoutsOf(s: Simulated, changes: Changes, mine: Set<Address>, yours: Changes, flows: Flow[], context: Context): Payout[] {
    const own = new Set<Address>([context.wallet, ...(context.wallets ?? [])]);
    const [back, paidAny] = [flows.some((f) => f.change > 0n), flows.some((f) => f.change < 0n)];
    const amount = (state: State, asset: string) => (asset === 'SOL' ? (state?.lamports ?? 0n) : units(state, asset));
    const gains = new Map<string, { holder: Address; address: Address; amount: bigint; wallet: boolean }[]>();
    const out = new Map<string, { holder: Address; amount: bigint }[]>(); // what left accounts not yours, by asset
    const [giving, getting] = [new Set<Address>(), new Set<Address>()];
    for (const c of changes.accounts) {
        const state = c.after ?? c.before;
        const holder = state?.token?.owner ?? stake(state)?.withdrawer ?? c.address;
        if (mine.has(c.address) || own.has(holder)) continue;
        const wallet = Boolean(state?.token || stake(state) || plain(state)) && !isOffCurveAddress(holder);
        const mints = new Set([c.before?.token, c.after?.token].flatMap((t) => (t && !t.native ? [t.mint] : [])));
        for (const asset of ['SOL', ...mints]) {
            const delta = amount(c.after, asset) - amount(c.before, asset);
            if (delta < 0n) {
                out.set(asset, [...(out.get(asset) ?? []), { holder, amount: -delta }]);
                giving.add(holder);
            }
            if (delta > 0n) {
                gains.set(asset, [...(gains.get(asset) ?? []), { holder, address: c.address, amount: delta, wallet }]);
                getting.add(holder);
            }
        }
    }
    const net = holdings(yours);
    const by = new Map<Address, Payout>();
    const sum = (list: { amount: bigint }[]) => list.reduce((n, g) => n + g.amount, 0n);
    for (const [asset, list] of gains) {
        const [before, after] = net.get(asset) ?? [0n, 0n];
        const [paid, got] = [before > after ? before - after : 0n, after > before ? after - before : 0n];
        const [wallets, programs] = [list.filter((g) => g.wallet), list.filter((g) => !g.wallet && !giving.has(g.holder))];
        const released = sum((out.get(asset) ?? []).filter((o) => !getting.has(o.holder) || (paidAny && !back)));
        // What you paid goes to wallets first, as payments do, then to programs' accounts, as deposits do.
        const toWallets = sum(wallets);
        const reached = sum(programs) < released ? sum(programs) : released;
        const unpaid = paid > toWallets ? paid - toWallets : 0n;
        const said = (part: bigint) => (part <= 0n || part * 20n <= got || (asset === 'SOL' && part <= RENT_BACK) ? 0n : part);
        for (const [group, share] of [[wallets, said(toWallets - paid)], [programs, said(reached - unpaid)]] as const) {
            let rest = share;
            for (const g of group.toSorted((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))) {
                if (rest <= 0n) break;
                const part = g.amount < rest ? g.amount : rest;
                rest -= part;
                const p = by.get(g.holder) ?? { holder: g.holder, known: context.contacts?.get(g.holder) ?? null, program: !g.wallet, amounts: [], programs: [] };
                p.amounts.push({ asset: asset as Payout['amounts'][number]['asset'], amount: part });
                p.programs = [...new Set([...p.programs, ...namers(s, g.address)])];
                by.set(g.holder, p);
            }
        }
    }
    return [...by.values()];
}

// An NFT that may come to you without any token balance showing it: a Metaplex Core asset that becomes yours, or a
// compressed one, which only Bubblegum's calls move (what they move, no account shows).
const CORE = address('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const BUBBLEGUM = address('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
function nftBack(s: Simulated, changes: Changes, key: ReadonlyUint8Array): boolean {
    const yoursAt = (state: State) => state?.program === CORE && state.data[0] === 1 && key.every((b, i) => state.data[1 + i] === b); // an asset: its kind, then its owner
    if (changes.accounts.some((c) => yoursAt(c.after) && !yoursAt(c.before))) return true;
    return s.message.instructions.some((ix) => s.accounts[ix.programAddressIndex].address === BUBBLEGUM) || s.simulation.inner.some((g) => g.calls.some((c) => c.program === BUBBLEGUM));
}

// The programs whose instructions name this account.
const namers = (s: Simulated, address: Address) =>
    s.message.instructions.filter((ix) => ix.accountIndices.some((j) => s.accounts[j].address === address)).map((ix) => s.accounts[ix.programAddressIndex].address);

// Nine tenths or more of your SOL, or of one of your tokens, leaving your accounts, the fee included: a site can ask
// for one of any size.
function outflows(yours: Changes): [string, Address | undefined][] {
    return [...holdings(yours)].flatMap(([asset, [before, kept]]): [string, Address | undefined][] => {
        const after = asset === 'SOL' ? kept - yours.fee : kept;
        return before > 0n && (before - after) * 10n >= before * 9n ? [asset === 'SOL' ? ['your SOL', undefined] : ['of one of your tokens', asset as Address]] : [];
    });
}

// Each asset of yours that moves, and on the other side the accounts whose same asset moved the other way.
function flowsOf(changes: Changes, yours: Changes, mine: Set<Address>): Flow[] {
    const others = changes.accounts.filter((c) => !mine.has(c.address));
    const amount = (s: State, asset: string) => (asset === 'SOL' ? (s?.lamports ?? 0n) : units(s, asset));
    return [...holdings(yours)].flatMap(([asset, [before, after]]): Flow[] => {
        const change = after - before;
        if (change === 0n) return [];
        const side = others.flatMap((c) => {
            const delta = amount(c.after, asset) - amount(c.before, asset);
            if (delta === 0n || delta > 0n === change > 0n) return [];
            const state = c.after ?? c.before;
            const staker = stake(state)?.withdrawer; // a stake account is whoever can withdraw it
            const holder = state?.token?.owner ?? staker ?? c.address;
            if (mine.has(holder)) return []; // stake of yours under someone's lockup: not someone else
            return [{ address: c.address, holder, amount: delta < 0n ? -delta : delta, wallet: state?.token || staker ? !isOffCurveAddress(holder) : plain(state) }];
        });
        return [{ asset: asset as Flow['asset'], change, others: side.toSorted((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)) }];
    });
}

// What each account of the transaction is: yours, a program, a mint, someone's token account or wallet, a program's.
function kindsOf(s: Simulated, changes: Changes, mine: Set<Address>, wallet: Address): Map<Address, Kind> {
    const after = new Map(changes.accounts.map((c) => [c.address, c.after]));
    return new Map(
        s.accounts.map((a): [Address, Kind] => {
            const state = read(a.state);
            if (a.address === wallet) return [a.address, 'you'];
            if (mine.has(a.address)) return [a.address, (state ?? after.get(a.address) ?? null)?.token ? 'your-tokens' : 'yours'];
            if (a.state.exists && a.state.executable) return [a.address, 'programs'];
            if (SYSVARS.has(a.address)) return [a.address, 'sysvars'];
            if (!state) return [a.address, 'new'];
            if (state.token) return [a.address, 'tokens'];
            if (isMint(state)) return [a.address, 'mints'];
            return [a.address, plain(state) ? 'wallets' : 'program-accounts'];
        }),
    );
}

function programUses(s: Simulated, explained: Explained[], mine: Set<Address>, { wallet }: Context): ProgramUse[] {
    const uses = new Map<Address, ProgramUse & { written: Set<Address> }>();
    s.message.instructions.forEach((ix, i) => {
        const program = s.accounts[ix.programAddressIndex].address;
        const touched = ix.accountIndices.map((j) => s.accounts[j]);
        const use = uses.get(program) ?? {
            program,
            name: explained[i].programName ?? PROGRAM_NAMES.get(program) ?? null,
            signature: false,
            writable: false,
            accounts: 0,
            unseen: false,
            written: new Set<Address>(),
        };
        const signs = touched.some((a) => a.address === wallet && a.signer);
        use.signature ||= signs;
        for (const a of touched) if (a.writable && mine.has(a.address)) use.written.add(a.address);
        use.writable = use.written.size > 0;
        use.accounts = use.written.size;
        use.unseen ||= signs && !s.simulation.innerListed;
        uses.set(program, use);
    });
    return [...uses.values()].map(({ written: _, ...use }) => use);
}

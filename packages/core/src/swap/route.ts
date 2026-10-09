// A swap's route, asked of Jupiter through Otus's server (`/swap/build`: the quote and the instructions Otus makes its
// own transaction from), and read strictly: Jupiter's answer is bytes from the network, so what does not have the
// exact shape asked for is refused, never guessed. The transaction is checked again in the background before it is
// reviewed: this only keeps a wrong route from being built at all.
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { AccountRole, getBase64Encoder, isAddress, type Address, type Instruction } from '@solana/kit';

import { TOKEN_2022_PROGRAM_ADDRESS } from '@otus-wallet/sdk/programs/addresses';
import { OTUS_RPC } from '../settings.ts';
import { termsOf } from './terms.ts';

/** Jupiter's aggregator: the one program a route's swap may call. */
export const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' as Address;

/** What is asked: `amount` of `input` (its smallest units) for `output`, by `taker`. */
export type Ask = { input: Address; output: Address; amount: bigint; taker: Address; slippageBps: number; maxAccounts: number };

/** A route as read: how much goes in, how much comes out as quoted and at least, through which venues, and what to
 *  build: setup (accounts opened, SOL wrapped), the swap, cleanup (SOL unwrapped), and the lookup tables they use. */
export type Route = {
    ask: Ask;
    out: bigint;
    least: bigint;
    impact: number | null; // percent
    venues: { label: string; share: number }[]; // share: percent of what goes in, at its step
    setup: Instruction[];
    swap: Instruction;
    cleanup: Instruction[];
    tables: Record<Address, Address[]>;
};

const WAIT = 8_000; // ms for a route to come
const MOST_TABLES = 8;
const MOST_SETUP = 6; // instructions: two accounts opened, SOL wrapped and synced, with room
const MOST_STEPS = 16; // of a route plan
const MOST_ACCOUNTS = 255; // in one instruction's list, repeats included: its count is one byte

/** A route for what is asked, through Otus's server; throws, in words, when there is none to build. */
export async function routeFor(ask: Ask): Promise<Route> {
    const query = `inputMint=${ask.input}&outputMint=${ask.output}&amount=${ask.amount}&taker=${ask.taker}&slippageBps=${ask.slippageBps}&maxAccounts=${ask.maxAccounts}`;
    // Posted: an extension's page sends its Origin, which Otus's server asks for, with a POST only.
    const response = await fetch(`${OTUS_RPC}/swap/build?${query}`, { method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(WAIT) });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(said(body) ?? `no route (${response.status})`);
    return readRoute(body, ask);
}

/** Jupiter's answer → the route, or a throw: it must be for exactly what was asked, ExactIn, at the slippage asked,
 *  its least no lower than the quote less that slippage; every instruction well formed with the taker its only signer,
 *  setup only opening the taker's accounts and wrapping SOL, the swap Jupiter's with the very terms the answer states
 *  (see `termsOf`) and no fee, cleanup only a token program's, and nothing else to run. */
export function readRoute(body: unknown, ask: Ask): Route {
    const b = record(body, 'the route');
    if (b.inputMint !== ask.input || b.outputMint !== ask.output || b.inAmount !== String(ask.amount) || b.swapMode !== 'ExactIn' || b.slippageBps !== ask.slippageBps) throw new Error('the route is not for what was asked');
    const out = units(b.outAmount);
    const least = units(b.otherAmountThreshold);
    if (least === 0n || least > out || least < out - (out * BigInt(ask.slippageBps) + 9_999n) / 10_000n) throw new Error('the route says too little');
    if (b.tipInstruction !== null && b.tipInstruction !== undefined) throw new Error('the route carries a tip');
    if (!Array.isArray(b.otherInstructions) || b.otherInstructions.length > 0) throw new Error('the route carries more to run');
    const ix = (v: unknown) => instruction(v, ask.taker);
    const setup = list(b.setupInstructions, MOST_SETUP).map(ix);
    if (setup.some((i) => !SETUP.includes(i.programAddress))) throw new Error('the route sets up with another program');
    // An account opened is the taker's, paid by it, with the System Program and a token program: the Associated Token
    // program takes the token program it is given, and the size it says.
    const opens = (i: Instruction) => i.accounts?.length === 6 && i.accounts[0].address === ask.taker && i.accounts[2].address === ask.taker && i.accounts[4].address === SYSTEM_PROGRAM_ADDRESS && TOKENS.includes(i.accounts[5].address);
    if (setup.some((i) => i.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS && !opens(i))) throw new Error('the route opens an account otherwise');
    const swap = ix(b.swapInstruction);
    if (swap.programAddress !== JUPITER) throw new Error('the route swaps with another program');
    const terms = termsOf(swap.data!, (i) => swap.accounts?.[i]?.address);
    const told = terms && terms.signer === ask.taker && terms.inputMint === ask.input && terms.outputMint === ask.output && terms.amount === ask.amount && terms.quoted === out && terms.slippageBps === ask.slippageBps;
    if (!told || terms.platformFeeBps !== 0 || terms.positiveSlippageBps !== 0 || (terms.elsewhere !== undefined && terms.elsewhere !== JUPITER)) throw new Error('the swap does not carry the route’s terms');
    const cleanup = b.cleanupInstruction === null || b.cleanupInstruction === undefined ? [] : [ix(b.cleanupInstruction)];
    if (cleanup.some((i) => !TOKENS.includes(i.programAddress))) throw new Error('the route cleans up with another program');
    if (list(b.computeBudgetInstructions).some((v) => record(v, 'an instruction').programId !== COMPUTE_BUDGET_PROGRAM_ADDRESS)) throw new Error('the route sets its budget with another program');
    return { ask, out, least, impact: percent(b.priceImpactPct), venues: list(b.routePlan, MOST_STEPS).map(venue), setup, swap, cleanup, tables: tables(b.addressesByLookupTableAddress) };
}

const TOKENS: Address[] = [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS];
const SETUP: Address[] = [ASSOCIATED_TOKEN_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS, ...TOKENS];

// One instruction as Jupiter gives it: its program, its accounts with their roles, and its data in base64. No one but
// the taker signs.
function instruction(v: unknown, taker: Address): Instruction {
    const i = record(v, 'an instruction');
    if (Object.keys(i).some((k) => !['programId', 'accounts', 'data'].includes(k))) throw new Error('an instruction has more than asked for');
    const accounts = list(i.accounts);
    if (accounts.length > MOST_ACCOUNTS) throw new Error('an instruction has too many accounts');
    return {
        programAddress: addressOf(i.programId),
        accounts: accounts.map((a) => {
            const { pubkey, isSigner, isWritable, ...rest } = record(a, 'an account');
            if (Object.keys(rest).length > 0 || typeof isSigner !== 'boolean' || typeof isWritable !== 'boolean') throw new Error('an account is not as asked');
            const address = addressOf(pubkey);
            if (isSigner && address !== taker) throw new Error('another key would sign the route');
            return { address, role: isSigner ? (isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : isWritable ? AccountRole.WRITABLE : AccountRole.READONLY };
        }),
        data: base64(i.data),
    };
}

// One step of the route: the venue's name, as its maker wrote it (no control or invisible characters, and short), and
// its share of what goes in.
function venue(v: unknown): { label: string; share: number } {
    const step = record(v, 'a step');
    const label = record(step.swapInfo, 'a step').label;
    const share = step.percent;
    if (typeof label !== 'string' || typeof share !== 'number' || !Number.isFinite(share) || share <= 0 || share > 100) throw new Error('a step is not as asked');
    return { label: label.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 32), share };
}

function tables(v: unknown): Record<Address, Address[]> {
    const t = record(v, 'the lookup tables');
    const keys = Object.keys(t);
    if (keys.length > MOST_TABLES) throw new Error('the route uses too many lookup tables');
    const read: Record<Address, Address[]> = {};
    for (const key of keys) {
        const addresses = list(t[key]);
        if (addresses.length === 0 || addresses.length > 256) throw new Error('a lookup table is not as asked');
        read[addressOf(key)] = addresses.map(addressOf);
    }
    return read;
}

function record(v: unknown, what: string): Record<string, unknown> {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${what} is not as asked`);
    return v as Record<string, unknown>;
}

function list(v: unknown, most = Infinity): unknown[] {
    if (!Array.isArray(v) || v.length > most) throw new Error('a list is not as asked');
    return v;
}

function addressOf(v: unknown): Address {
    if (typeof v !== 'string' || !isAddress(v)) throw new Error('an address is not as asked');
    return v;
}

// A whole number of units, written plainly: digits, no leading zero, within u64.
function units(v: unknown): bigint {
    if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(v) || BigInt(v) > 0xffff_ffff_ffff_ffffn) throw new Error('an amount is not as asked');
    return BigInt(v);
}

function percent(v: unknown): number | null {
    const n = typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? n * 100 : null; // Jupiter says it as a fraction
}

function base64(v: unknown): Uint8Array {
    if (typeof v !== 'string' || v.length > 4096 || !/^[A-Za-z0-9+/]*={0,2}$/.test(v) || v.length % 4 !== 0) throw new Error('an instruction’s data is not as asked');
    return new Uint8Array(getBase64Encoder().encode(v));
}

// What Otus's server or Jupiter said went wrong, when it said it in words.
function said(body: unknown): string | null {
    const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    return typeof error === 'string' ? error.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 120) : null;
}

// The terms a Jupiter swap carries, read from its instruction exactly as Jupiter v6's IDL (published onchain) lays them
// out: what goes in, the quote, the slippage and the fees, from which account of the taker's, of which mint, into which.
// Only the two ExactIn routes Jupiter's /build gives (route_v2, shared_accounts_route_v2) are read; anything else is
// not a swap Otus asked for. The route plan after them is Jupiter's own to check.
import { isAddress as kitIsAddress, type Address, type ReadonlyUint8Array } from '@solana/kit';

/** route_v2: the taker's own accounts swap through the route. */
const ROUTE_V2 = [0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14];
/** shared_accounts_route_v2: through Jupiter's program-owned accounts, `id` choosing them. */
const SHARED_V2 = [0xd1, 0x98, 0x53, 0x93, 0x7c, 0xfe, 0xd8, 0xe9];

/** Whether a swap instruction's data is route_v2's: it swaps through the taker's own accounts of each token between, which
 *  it names writable. The shared route swaps through Jupiter's own. */
export const throughOwn = (data: ReadonlyUint8Array) => ROUTE_V2.every((b, i) => data[i] === b);

/** What a swap instruction says. `destination`: where what comes out lands; `elsewhere`: route_v2's optional other
 *  destination, which Otus leaves unset (Jupiter's own address stands for none); null for the shared route, which has
 *  none. */
export type Terms = {
    signer: Address | undefined;
    source: Address | undefined;
    destination: Address | undefined;
    inputMint: Address | undefined;
    outputMint: Address | undefined;
    inputProgram: Address | undefined;
    outputProgram: Address | undefined;
    elsewhere: Address | null | undefined;
    amount: bigint;
    quoted: bigint;
    slippageBps: number;
    platformFeeBps: number;
    positiveSlippageBps: number;
};

/** A swap instruction's data and its accounts (`at(i)`, the i-th account's address, of `count`) → its terms; null when
 *  it is not one of the two routes, its data too short, or its accounts fewer than its IDL names (10 for route_v2, 12
 *  for the shared route). */
export function termsOf(data: ReadonlyUint8Array, at: (i: number) => Address | undefined, count: number): Terms | null {
    const route = SHARED_V2.every((b, i) => data[i] === b) ? 'shared' : ROUTE_V2.every((b, i) => data[i] === b) ? 'own' : null;
    if (route === null || count < (route === 'shared' ? 12 : 10)) return null;
    const from = route === 'shared' ? 9 : 8; // past the discriminator, and the shared route's id
    if (data.length < from + 22) return null; // its amounts and rates; the route plan follows
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const numbers = { amount: view.getBigUint64(from, true), quoted: view.getBigUint64(from + 8, true), slippageBps: view.getUint16(from + 16, true), platformFeeBps: view.getUint16(from + 18, true), positiveSlippageBps: view.getUint16(from + 20, true) };
    if (route === 'own') return { signer: at(0), source: at(1), destination: at(2), inputMint: at(3), outputMint: at(4), inputProgram: at(5), outputProgram: at(6), elsewhere: at(7), ...numbers };
    return { signer: at(1), source: at(2), destination: at(5), inputMint: at(6), outputMint: at(7), inputProgram: at(8), outputProgram: at(9), elsewhere: null, ...numbers };
}

/** What the popup asked for, which the background holds the swap's terms to: the mints, the amount in, the quote and
 *  the slippage. */
export type Asked = { input: Address; output: Address; amount: bigint; out: bigint; slippageBps: number };

/** As the popup sends it: amounts as decimal text. */
export const askedWire = (a: Asked) => ({ input: a.input, output: a.output, amount: String(a.amount), out: String(a.out), slippageBps: a.slippageBps });

/** What the popup sent → what it asked for; null when it is not that, exactly. */
export function askedFrom(v: unknown): Asked | null {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const { input, output, amount, out, slippageBps, ...rest } = v as Record<string, unknown>;
    const whole = (s: unknown) => typeof s === 'string' && /^[1-9][0-9]{0,19}$/.test(s) && BigInt(s) <= 0xffff_ffff_ffff_ffffn;
    if (Object.keys(rest).length > 0 || !isAddress(input) || !isAddress(output) || input === output || !whole(amount) || !whole(out)) return null;
    if (typeof slippageBps !== 'number' || !Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 1_000) return null;
    return { input, output, amount: BigInt(amount as string), out: BigInt(out as string), slippageBps };
}

const isAddress = (v: unknown): v is Address => typeof v === 'string' && kitIsAddress(v);

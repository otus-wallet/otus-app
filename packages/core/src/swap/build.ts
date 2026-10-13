// A swap Otus builds from a route, for the same review as any transaction: Compute Budget's limit first (the most there
// is, which Otus fits when it prepares it, adding the priority fee and the guards), the route's setup, swap and
// cleanup, then a tip to Helius Sender, which lands it. A v0 message through the route's lookup tables: a route names
// more accounts than a transaction could list itself.
import { MAX_COMPUTE_UNIT_LIMIT, getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { getTransferSolInstruction } from '@solana-program/system';
import {
    appendTransactionMessageInstructions,
    compileTransaction,
    compressTransactionMessageUsingAddressLookupTables,
    createNoopSigner,
    createTransactionMessage,
    getTransactionEncoder,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import { SENDER_TIPS, WSOL } from '@otus-wallet/sdk/programs/addresses';
import type { Lifetime } from '../send/transfer.ts';
import { routeFor, type Ask, type Route } from './route.ts';

// Helius Sender's tip accounts, one of them paid per transaction: the SDK's list, which Activity tells a tip by.
export { SENDER_TIPS };

/** The tip, in lamports: above Sender's least on the stake-weighted path Otus's server sends through (5,000). */
export const TIP = 10_000n;

/** The unsigned swap, as wire bytes, that the route's taker signs and pays for; `tipTo`: which of Sender's accounts. */
export function swapping(route: Route, lifetime: Lifetime, tipTo = SENDER_TIPS[Math.floor(Math.random() * SENDER_TIPS.length)]): Uint8Array {
    const owner = route.ask.taker;
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(owner, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        (m) =>
            appendTransactionMessageInstructions(
                [getSetComputeUnitLimitInstruction({ units: MAX_COMPUTE_UNIT_LIMIT }), ...route.setup, route.swap, ...route.cleanup, getTransferSolInstruction({ source: createNoopSigner(owner), destination: tipTo, amount: TIP })],
                m,
            ),
        (m) => compressTransactionMessageUsingAddressLookupTables(m, route.tables),
    );
    return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
}

/** The most bytes a v0 transaction may have. */
const MOST_BYTES = 1232;
/** What Otus's guards take when it prepares a swap, as measured: Lighthouse and two holds, the wallet and the token
 *  got or paid when the other side is SOL (its wrapped account is closed, and holds nothing), about 172 bytes; with a
 *  token on each side, three holds, about 260. With room to spare. */
const guardRoom = (ask: Pick<Ask, 'input' | 'output'>) => (ask.input === WSOL || ask.output === WSOL ? 190 : 270);
/** The accounts a route may use, tried in turn: fewer leave more room, at the cost of fewer venues. */
export const MOST_ACCOUNTS = [64, 48, 36, 28, 20];

/** A route for what is asked whose swap leaves room for the guards: asked with fewer accounts while it does not. The
 *  last one tried when none does: then it goes unguarded, and the review says so. */
export async function fittingRoute(ask: Omit<Ask, 'maxAccounts'>, find: (ask: Ask) => Promise<Route> = routeFor): Promise<Route> {
    let route: Route | null = null;
    for (const maxAccounts of MOST_ACCOUNTS) {
        route = await find({ ...ask, maxAccounts });
        if (swapping(route, SIZED, SENDER_TIPS[0]).length + guardRoom(ask) <= MOST_BYTES) return route;
    }
    return route!;
}

// Any lifetime sizes a transaction the same: a blockhash is always 32 bytes.
const SIZED: Lifetime = { blockhash: '11111111111111111111111111111111' as Lifetime['blockhash'], lastValidBlockHeight: 0n };

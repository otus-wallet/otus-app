// How Activity cuts an address short on its page; the words themselves are the SDK's (rows()), with addresses whole.
import type { Address } from '@solana/kit';

import type { Activity } from '@otus-wallet/sdk/activity/summary';
import { cutAmong } from './names.ts';

/** How the page cuts an address short: four characters a side, or, for one like others on the page or known, as far as
 *  where it parts from each of them. */
export const cuts = (read: (Activity | { unreadable: string })[], known: Address[]) => cutAmong([...known, ...read.flatMap((a) => ('kind' in a && a.other ? [a.other] : []))]);

/** The tokens a page moved, its own and inside programs Otus doesn't know: to be named in one search. */
export const mintsIn = (read: (Activity | { unreadable: string })[]): string[] =>
    [...new Set(read.flatMap((a) => ('kind' in a ? [...a.moves, ...a.through].flatMap((m) => (m.mint ? [m.mint] : [])) : [])))].sort();


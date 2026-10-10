// The popup's reads from the network, cached and kept fresh by TanStack Query: what each wallet holds, its activity, who
// else has access to it, and the account at an address typed. A read that fails is tried again a little later, as a
// public RPC turns away bursts. What each wallet holds, the first page of its activity and its access are also kept for
// the browser session, so the popup opens with them and reads them again.
import { QueryClient, type InfiniteData } from '@tanstack/react-query';

import { platform } from '@otus-wallet/core/platform.ts';
import type { Holdings } from '@otus-wallet/core/holdings.ts';
import type { ActivityPage } from './store.ts';

export const queries = new QueryClient({
    defaultOptions: { queries: { retry: 2, refetchOnWindowFocus: false, staleTime: 10_000 } },
});

export const holdingsKey = (rpc: string, address: string) => ['holdings', rpc, address] as const;
export const activityKey = (rpc: string, address: string) => ['activity', rpc, address] as const;
/** `stamp`: when a site was last signed for something it can still use, so that signing anew reads it again. */
export const accessKey = (rpc: string, address: string, stamp: number) => ['access', rpc, address, stamp] as const;

/** A wallet's activity as read, a page at a time. */
export type ActivityPages = InfiniteData<ActivityPage, string | null>;

const KEPT = 'held'; // in session storage: in memory only, gone with the browser, out of content scripts' reach
const KEEP = 24; // queries: holdings, activity and access of the last few wallets
type Kept = Record<string, { at: number; packed: string }>; // by query key; bigints as strings, as storage takes JSON

const pack = (v: unknown) => JSON.stringify(v, (_, x: unknown) => (typeof x === 'bigint' ? { bigint: x.toString() } : x));
const unpack = (s: string): unknown =>
    JSON.parse(s, (_, v: unknown) => (v !== null && typeof v === 'object' && Object.keys(v).length === 1 && typeof (v as { bigint?: unknown }).bigint === 'string' ? BigInt((v as { bigint: string }).bigint) : v));

let kept: Kept = {};

// How long after a transaction lands what it changed is read again: several landing together are read once, and an RPC
// a little behind the network has caught up. A read this soon after one landed may not show it yet.
const LANDED_WAIT = 1_500;
let soon: ReturnType<typeof setTimeout> | undefined;

/** A transaction Otus signed landed: what each wallet holds, its stake, who else has access, its tokens' terms (it may
 *  have changed an authority) and its activity are read again in a moment, and the activity kept this session is
 *  dropped. */
export function landed() {
    clearTimeout(soon);
    soon = setTimeout(() => {
        for (const key of ['holdings', 'stakes', 'access', 'mintTerms', 'mintTermsAhead']) void queries.invalidateQueries({ queryKey: [key] });
        void queries.resetQueries({ queryKey: ['activity'] });
        forgetActivity();
    }, LANDED_WAIT);
}

/** Drops the activity kept this session: a transfer landed, so what was read is behind. */
export function forgetActivity() {
    kept = Object.fromEntries(Object.entries(kept).filter(([key]) => !key.startsWith('["activity"')));
    void platform.storage.session.set({ [KEPT]: kept });
}

/** Puts what each wallet held, as last read this session, into the cache: before the popup draws. */
export async function restore() {
    try {
        const stored = await platform.storage.session.get({ [KEPT]: {}, settled: 0 });
        kept = ((stored[KEPT] ?? {}) as Kept) || {};
        const settled = typeof stored.settled === 'number' ? stored.settled : 0; // when a transaction Otus signed last landed
        for (const [key, { at, packed }] of Object.entries(kept)) {
            const queryKey = JSON.parse(key);
            const data = unpack(packed);
            queries.setQueryData(queryKey, queryKey[0] === 'activity' ? { pages: [data], pageParams: [null] } : data, { updatedAt: at });
            // Read before it landed (or too soon after) while the popup was closed: shown at once all the same, and read again.
            if (at < settled + 2 * LANDED_WAIT) void queries.invalidateQueries({ queryKey, exact: true });
        }
    } catch {
        kept = {}; // nothing kept, or kept by another build: read afresh
    }
    // Each read that works is kept, for the last few wallets: of their activity, the first page.
    queries.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'success' || !['holdings', 'activity', 'access'].includes(event.query.queryKey[0] as string)) return;
        const first = event.query.queryKey[0] === 'activity' ? (event.query.state.data as ActivityPages).pages[0] : null;
        kept[JSON.stringify(event.query.queryKey)] = first ? { at: first.at, packed: pack(first) } : { at: event.query.state.dataUpdatedAt, packed: pack(event.query.state.data) };
        kept = Object.fromEntries(Object.entries(kept).toSorted(([, a], [, b]) => b.at - a.at).slice(0, KEEP));
        void platform.storage.session.set({ [KEPT]: kept });
    });
}

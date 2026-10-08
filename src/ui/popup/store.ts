// The popup's data: what the extension keeps and whether Otus is locked, read again whenever the stored state
// changes, so every screen follows what the background and other pages do; and what each wallet holds, through the
// popup's query cache.
import { isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, type Address } from '@solana/kit';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { historyPage, NoHistory } from '@otus-wallet/sdk/activity/history';
import { summarize, type Activity } from '@otus-wallet/sdk/activity/summary';
import { access } from '@otus-wallet/sdk/access/access';
import { rpcAt, timedOut } from '@otus-wallet/sdk/rpc';
import type { KeyStatus } from '../../shell/keys.ts';
import { load, save, type Edit, type State } from '../../shell/state.ts';
import { ask } from '../ask.ts';
import { holdings, type Holdings } from '../holdings.ts';
import { accessKey, activityKey, forgetActivity, holdingsKey, queries, type ActivityPages } from './query.ts';

export type Otus = { state: State; keys: KeyStatus };

/** The stored state and the keystore's status, as they are now; null until first read. */
export function useOtus(): Otus | null {
    const [now, setNow] = useState<Otus | null>(null);
    useEffect(() => {
        let live = true;
        const read = async () => {
            const [state, reply] = await Promise.all([load(), ask({ keys: 'status' })]);
            if (live) setNow({ state, keys: reply.ok ? (reply.result as KeyStatus) : { vault: false, unlocked: false } });
        };
        const changed = (_: unknown, area: string) => void ((area === 'local' || area === 'session') && read());
        read();
        chrome.storage.onChanged.addListener(changed);
        return () => {
            live = false;
            chrome.storage.onChanged.removeListener(changed);
        };
    }, []);
    return now;
}

const REFRESH = 30_000; // ms between reads of what a wallet holds, while it is shown

// A transfer made here that landed (or failed) changed what the wallet holds: the balances are read again then, and the
// activity from its first page.
chrome.storage.onChanged.addListener((changes, area) => {
    const last = changes.lastTransfer?.newValue as { pending?: boolean } | undefined;
    if (area !== 'session' || !last || last.pending) return;
    void queries.invalidateQueries({ queryKey: ['holdings'] });
    void queries.resetQueries({ queryKey: ['activity'] });
    forgetActivity();
});

/**
 * What a wallet holds: the last read at once, this session's included, then read again; again every half minute while
 * shown, and once a transfer made here lands. A read that fails keeps what was read before; an error shows only when
 * nothing was ever read.
 */
export function useHoldings(rpc: string, address: Address): Holdings | Error | undefined {
    const read = useQuery({ queryKey: holdingsKey(rpc, address), queryFn: () => holdings(rpc, address), refetchInterval: REFRESH });
    return read.data ?? read.error ?? undefined;
}

/** A page of a wallet's activity: each transaction in short, or why Otus could not read it; where the next starts; and
 *  when it was read (ms). */
export type ActivityPage = { rows: (Activity | { unreadable: string })[]; next: string | null; at: number };

const FRESH = 60_000; // ms a page of activity is taken as current

/**
 * A wallet's activity, newest first: a page of 10 when shown (the one kept this session, when it is under a minute
 * old), then each next page as asked for. One request a page; never read in the background, nor again on its own.
 * Left, what it reads is dropped and it keeps its first page only, as old as it is, so coming back reads one page at
 * most.
 */
export function useActivity(rpc: string, address: Address) {
    const read = useInfiniteQuery({
        queryKey: activityKey(rpc, address),
        queryFn: async ({ pageParam, signal }): Promise<ActivityPage> => {
            const page = await historyPage(rpc, address, pageParam ?? undefined, signal);
            return { rows: page.items.map((i) => ('unreadable' in i ? i : summarize(i, address))), next: page.next, at: Date.now() };
        },
        initialPageParam: null as string | null,
        getNextPageParam: (last, _, from) => (last.next !== from ? last.next : null), // a page that points at itself ends it
        staleTime: FRESH,
        refetchOnReconnect: false,
        retry: (count, e) => !(e instanceof NoHistory) && count < 2,
    });
    useEffect(() => {
        const key = activityKey(rpc, address);
        return () =>
            void queries.cancelQueries({ queryKey: key }).then(() => {
                const d = queries.getQueryData<ActivityPages>(key);
                if (d && d.pages.length > 1) queries.setQueryData<ActivityPages>(key, { pages: d.pages.slice(0, 1), pageParams: d.pageParams.slice(0, 1) }, { updatedAt: d.pages[0].at });
            });
    }, [rpc, address]);
    return read;
}

const ACCESS_FRESH = 5 * 60_000; // ms who else has access is taken as current: it changes only when you sign

/** Who besides the wallet can move, burn, freeze or close what it holds, and the site behind each when Otus knows it:
 *  read when shown, at most every five minutes, and again once a site is signed for something it can still use. Three
 *  requests: its token accounts of each token program, then their mints with the nonce accounts it waits on. */
export function useAccess(rpc: string, address: Address, state: State) {
    const waiting = state.waiting.filter((w) => w.wallet === address);
    const stamp = Math.max(0, ...waiting.map((w) => w.at), ...state.given.map((g) => g.at));
    return useQuery({
        queryKey: accessKey(rpc, address, stamp),
        queryFn: () => access(rpcAt(rpc), address, waiting.map(({ account, nonce }) => ({ account, nonce }))),
        staleTime: ACCESS_FRESH,
        refetchOnReconnect: false,
    });
}

/** What a wallet held when last read, without reading it: names for its tokens. */
export const useHeldNow = (rpc: string, address: Address) => useQuery({ queryKey: holdingsKey(rpc, address), queryFn: () => holdings(rpc, address), enabled: false }).data;

/** What these wallets held when last read, without reading them: for the list of wallets. */
export function useHeld(rpc: string, addresses: Address[]): (Holdings | undefined)[] {
    return useQueries({ queries: addresses.map((address) => ({ queryKey: holdingsKey(rpc, address), queryFn: () => holdings(rpc, address), enabled: false })) }).map((q) => q.data);
}

/** An error in one short line. Kit's errors carry only a code in this build: an RPC's HTTP status is said instead. */
export function said(e: unknown): string {
    if (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return e.context.statusCode === 429 ? 'too many requests (HTTP 429)' : `HTTP ${e.context.statusCode}`;
    if (isSolanaError(e)) return e.message.split(';')[0];
    if (timedOut(e)) return 'no answer in time';
    return e instanceof Error ? e.message.split('\n')[0].slice(0, 160) : String(e);
}

/** Accounts and sites change in the background, their one writer, as other things change them too. */
export const edit = (e: Edit) => chrome.runtime.sendMessage(e);

/** Settings are the popup's alone: written from the state as it is now. */
export const setSettings = async (change: (s: State['settings']) => Partial<State['settings']>) => {
    const { settings } = await load();
    await save({ settings: { ...settings, ...change(settings) } });
};

/** The wallet in use, or the first. */
export const current = (state: State) => state.accounts.find((a) => a.address === state.active) ?? state.accounts[0];

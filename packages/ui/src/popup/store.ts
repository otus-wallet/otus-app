// The popup's data: what the extension keeps and whether Otus is locked, read again whenever the stored state
// changes, so every screen follows what the background and other pages do; and what each wallet holds, through the
// popup's query cache.
import { isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, type Address } from '@solana/kit';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { historyPage, NoHistory, type Unreadable } from '@otus-wallet/sdk/activity/history';
import { summarize, type Activity } from '@otus-wallet/sdk/activity/summary';
import { access } from '@otus-wallet/sdk/access/access';
import { tokensTerms, tokenTerms } from '@otus-wallet/sdk/access/mint';
import { rpcAt, timedOut } from '@otus-wallet/sdk/rpc';
import { platform } from '@otus-wallet/core/platform.ts';
import type { KeyStatus } from '@otus-wallet/core/keystore.ts';
import { load, save, signs, type Edit, type State } from '@otus-wallet/core/state.ts';
import { lookOutside, outsideKey, unchecked, type Looked, type Outside } from '@otus-wallet/core/outside.ts';
import { networkOf, walletRpc } from '@otus-wallet/core/settings.ts';
import { ask } from '../ask.ts';
import { holdings, type Holdings } from '@otus-wallet/core/holdings.ts';
import { epochOf, stakeRent, stakesOf } from '@otus-wallet/core/stake/stakes.ts';
import { validatorNames, validatorsOf } from '@otus-wallet/core/stake/validators.ts';
import { named } from '@otus-wallet/core/state.ts';
import { accessKey, activityKey, holdingsKey, landed, queries, type ActivityPages } from './query.ts';

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
        platform.storage.onChanged.addListener(changed);
        return () => {
            live = false;
            platform.storage.onChanged.removeListener(changed);
        };
    }, []);
    return now;
}

const REFRESH = 30_000; // ms between reads of what a wallet holds, while it is shown

// A transaction Otus signed, yours or a site's, landed (or failed, paying its fee): what it changed is read again.
platform.storage.onChanged.addListener((changes, area) => void (area === 'session' && changes.settled?.newValue && landed()));

/**
 * What a wallet holds: the last read at once, this session's included, then read again; again every half minute while
 * shown, and once a transaction Otus signed lands. A read that fails keeps what was read before; an error shows only
 * when nothing was ever read.
 */
export function useHoldings(rpc: string, address: Address, mainnet = true): Holdings | Error | undefined {
    const read = useQuery({ queryKey: holdingsKey(rpc, address), queryFn: () => holdings(rpc, address, mainnet), refetchInterval: REFRESH });
    return read.data ?? read.error ?? undefined;
}

/** A page of a wallet's activity: each transaction in short, or why Otus could not read it; where the next starts; and
 *  when it was read (ms). */
export type ActivityPage = { rows: (Activity | Unreadable)[]; next: string | null; at: number };

const FRESH = 60_000; // ms a page of activity is taken as current
const PAGE = 25; // transactions a page: what is checked for ones signed outside Otus, at one request's cost all the same

/**
 * A wallet's activity, newest first, 25 transactions a page: the first as the popup opens for a wallet that signs and
 * when shown (the one kept this session, when it is under a minute old), then each next as asked for. One request a
 * page; never again on its own. Left, what it reads is dropped and it keeps its first page only, as old as it is, so
 * coming back reads one page at most. A transaction Otus cannot tell in short shows as unreadable, alone.
 */
export function useActivity(rpc: string, address: Address) {
    const read = useInfiniteQuery({
        queryKey: activityKey(rpc, address),
        queryFn: async ({ pageParam, signal }): Promise<ActivityPage> => {
            const page = await historyPage(rpc, address, pageParam ?? undefined, signal, PAGE);
            return { rows: page.items.map((i) => ('unreadable' in i ? i : told(i, address))), next: page.next, at: Date.now() };
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

// A landed transaction in short, or unreadable when its summary fails: one never takes the page with it.
function told(t: Parameters<typeof summarize>[0], address: Address): Activity | Unreadable {
    try {
        return summarize(t, address);
    } catch {
        return { unreadable: 'Otus could not tell it', slot: t.slot, signature: t.signature, signatures: t.signatures };
    }
}

const AHEAD_PAGES = 4; // pages read on their own while part is unchecked, each time the popup opens: 100 transactions

/**
 * The wallet in use, when it signs: its activity read as the popup opens, and as more of it is read, checked for
 * transactions it signed that Otus did not. More landed than the first page holds (a flood of transfers can push one
 * down): the next pages are read on their own, up to four, until all is checked.
 */
export function useLookOutside(state: State) {
    const wallet = current(state).address;
    const key = outsideKey(networkOf(state.settings), wallet);
    const read = useActivity(walletRpc(state.settings), wallet);
    const ahead = useRef({ read, pages: 0 });
    ahead.current.read = read;
    const more = read.hasNextPage;
    useEffect(() => {
        const rows = read.data?.pages.flatMap((p) => p.rows);
        // Every row with its slot and signatures, or none checked: a page kept by an older build has neither. One Otus
        // could not read is checked by its envelope, when that reads.
        if (!rows || !rows.every((r) => 'unreadable' in r || (typeof r.slot === 'bigint' && r.signatures))) return;
        const looked = rows.flatMap((r): Looked[] => (typeof r.slot === 'bigint' && r.signatures && typeof r.signature === 'string' ? [{ signature: r.signature, slot: r.slot, time: r.time ?? null, signatures: r.signatures }] : []));
        void lookedOutside(key, wallet, looked, more).then((now) => {
            const { read: latest, pages } = ahead.current;
            if (!unchecked(now) || !latest.hasNextPage || latest.isFetching || pages >= AHEAD_PAGES) return;
            ahead.current.pages++;
            void latest.fetchNextPage();
        });
    }, [read.data, more, key, wallet]);
}

let looking: Promise<unknown> = Promise.resolve();

// A wallet's activity as read → what is checked of it, kept, and given back: one check at a time, each from what is
// stored then. Only the popup writes these, and only for accounts Otus still has.
function lookedOutside(key: string, wallet: Address, read: Looked[], more: boolean): Promise<Outside | undefined> {
    const done = looking.then(async () => {
        const { outside, signedHere, accounts } = await load();
        const account = accounts.find((a) => a.address === wallet);
        if (!account || !signs(account)) return undefined;
        const { now } = lookOutside({ read, wallet, before: outside[key], here: new Set(signedHere[wallet] ?? []), since: account.since, more, now: Math.floor(Date.now() / 1000) });
        if (JSON.stringify(now) === JSON.stringify(outside[key])) return now;
        const kept = Object.fromEntries(Object.entries(outside).filter(([k]) => accounts.some((a) => k.endsWith(` ${a.address}`))));
        await save({ outside: { ...kept, [key]: now } });
        return now;
    });
    looking = done.catch(() => {});
    return done.catch(() => undefined); // not kept: checked again as the activity is read again
}

/** Activity seen: what was found signed outside Otus no longer marks its tab. */
export function seenOutside(key: string) {
    looking = looking
        .then(async () => {
            const { outside } = await load();
            if (outside[key]?.unseen) await save({ outside: { ...outside, [key]: { ...outside[key], unseen: false } } });
        })
        .catch(() => {});
}

const ACCESS_FRESH = 5 * 60_000; // ms who else has access is taken as current: it changes only when you sign

/** Who besides the wallet can move, burn, freeze or close what it holds, and the site behind each when Otus knows it:
 *  read when shown, at most every five minutes, and again once a site is signed for something it can still use, or a
 *  transaction Otus signed lands. Three requests: its token accounts of each token program, then their mints with the
 *  nonce accounts it waits on. */
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

const MINT_FRESH = 10 * 60_000; // ms a token's terms are taken as current: its authorities hardly ever change
// Kept as long, though nothing shows them yet: read ahead, they wait for their details to open.
queries.setQueryDefaults(['mintTerms'], { gcTime: MINT_FRESH });

const AHEAD = 50; // tokens whose details are read ahead: their mints and metadata accounts fill one request

/** A token's terms and whether its metadata can change: read ahead with the wallet's other tokens, or on its own once
 *  its details are opened. */
export const useTokenTerms = (rpc: string, mint: Address) => useQuery({ queryKey: ['mintTerms', rpc, mint], queryFn: () => tokenTerms(rpcAt(rpc), mint), staleTime: MINT_FRESH, refetchOnReconnect: false });

/** Reads ahead the details of the tokens a wallet shows, the first AHEAD of them in one request, at most every ten
 *  minutes: each opens complete, at once. */
export function useDetailsAhead(rpc: string, mints: Address[]) {
    const ahead = mints.slice(0, AHEAD).toSorted();
    useQuery({
        queryKey: ['mintTermsAhead', rpc, ahead.join(',')],
        queryFn: async () => {
            for (const [mint, terms] of await tokensTerms(rpcAt(rpc), ahead)) queries.setQueryData(['mintTerms', rpc, mint], terms);
            return ahead.length;
        },
        enabled: ahead.length > 0,
        staleTime: MINT_FRESH,
        refetchOnReconnect: false,
    });
}

const STAKE_FRESH = 30_000; // ms a wallet's stake accounts, and the epoch, are taken as current
const VALIDATORS_FRESH = 10 * 60_000; // ms the validators are
const NAMES_FOR = 7 * 24 * 3600_000; // ms validators' names are kept: reading them all is megabytes

/** The stake accounts a wallet withdraws from, read again now and then while shown: what was sent lands meanwhile. */
export const useStakes = (rpc: string, address: Address) => useQuery({ queryKey: ['stakes', rpc, address], queryFn: () => stakesOf(rpcAt(rpc), address), staleTime: STAKE_FRESH, refetchInterval: STAKE_FRESH });

/** The epoch, and about how long is left of it. */
export const useEpoch = (rpc: string) => useQuery({ queryKey: ['epoch', rpc], queryFn: () => epochOf(rpcAt(rpc)), staleTime: STAKE_FRESH });

/** What a new stake hangs on: the network's least stake, and a stake account's rent. */
export const useStakeTerms = (rpc: string) =>
    useQuery({
        queryKey: ['stakeTerms', rpc],
        queryFn: async () => {
            const r = rpcAt(rpc);
            const [{ value: min }, rent] = await Promise.all([r.getStakeMinimumDelegation({ commitment: 'confirmed' }).send(), stakeRent(r)]);
            return { min, rent };
        },
        staleTime: STAKE_FRESH,
    });

/** The validators of the network the wallet shows, ranked; their names kept for a week, those of validators alive.
 *  Names that cannot be read leave the validators by address. */
export const useValidators = (rpc: string, cluster: string, epoch: bigint | undefined) =>
    useQuery({
        queryKey: ['validators', rpc, String(epoch)],
        queryFn: () => validatorsOf(rpcAt(rpc), epoch!, (nodes) => namesFor(rpc, cluster, nodes).catch(() => new Map<string, string>())),
        enabled: epoch !== undefined,
        staleTime: VALIDATORS_FRESH,
    });

type KeptNames = Record<string, { at: number; names: [string, string][] }>; // by network

async function namesFor(rpc: string, cluster: string, nodes: Set<string>): Promise<Map<string, string>> {
    const kept = (((await platform.storage.local.get('validatorNames')).validatorNames ?? {}) as KeptNames) || {};
    const mine = kept[cluster];
    if (mine && Date.now() - mine.at < NAMES_FOR && Array.isArray(mine.names)) {
        return new Map(mine.names.filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string' && named(e[1])).map(([node, name]) => [node, named(name)]));
    }
    const names = [...(await validatorNames(rpcAt(rpc)))].filter(([node]) => nodes.has(node));
    if (names.length > 0) await platform.storage.local.set({ validatorNames: { ...kept, [cluster]: { at: Date.now(), names } } }).catch(() => {}); // none: read again next time
    return new Map(names);
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
export const edit = (e: Edit) => platform.send(e);

/** Settings are the popup's alone: written from the state as it is now. */
export const setSettings = async (change: (s: State['settings']) => Partial<State['settings']>) => {
    const { settings } = await load();
    await save({ settings: { ...settings, ...change(settings) } });
};

/** The wallet in use, or the first. */
export const current = (state: State) => state.accounts.find((a) => a.address === state.active) ?? state.accounts[0];

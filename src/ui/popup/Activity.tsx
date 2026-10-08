// The wallet's activity: its transactions, newest first, by day, each in a line; opened, everything its transaction
// told, and the way to it in the explorer chosen. A page of 10 is read when the screen shows, the next as the list
// ends in view, one request each; names come from what Otus knows already, never from another request.
import type { Address } from '@solana/kit';
import { useEffect, useMemo, useRef, useState } from 'react';

import { NoHistory } from '@otus-wallet/sdk/activity/history';
import type { Activity } from '@otus-wallet/sdk/activity/summary';
import { short } from '@otus-wallet/sdk/format';
import { USDC, USDT, WSOL } from '@otus-wallet/sdk/programs/addresses';
import { PROGRAM_NAMES } from '@otus-wallet/sdk/programs/known';
import { explorerOf, networkOf, walletRpc } from '../../settings.ts';
import type { State } from '../../shell/state.ts';
import { cachedToken } from '../../tokens.ts';
import { Button } from '../components/ui/button.tsx';
import { Icon } from '../components/icons.tsx';
import { Tagged } from '../components/you.tsx';
import { YOU } from '../view/names.ts';
import { cn } from '../lib/cn.ts';
import { accessWords, others } from '../view/access.ts';
import { rows, type Naming, type Part, type Row } from '../view/activity.ts';
import type { Screen } from './App.tsx';
import { TabBar, Tip } from './common.tsx';
import { WalletBar } from './Lobby.tsx';
import { current, said, useAccess, useActivity, useHeldNow } from './store.ts';

export const KNOWN_SYMBOLS: Record<string, string> = { [USDC]: 'USDC', [USDT]: 'USDT', [WSOL]: 'wSOL' };

export function ActivityScreen({ state, go }: { state: State; go: (to: Screen) => void }) {
    const account = current(state);
    const rpc = walletRpc(state.settings);
    const read = useActivity(rpc, account.address);
    const held = useHeldNow(rpc, account.address);
    const naming = useMemo((): Naming => {
        const verified = new Map((held?.assets ?? []).filter((a) => a.verified && a.symbol && !a.native).map((a) => [a.mint, a.symbol]));
        const names = new Map<string, string>([...state.contacts, ...state.accounts].map((k) => [k.address, k.label]));
        // Names from Jupiter and the tokens everyone knows are mainnet's: elsewhere the same addresses are other tokens.
        const mainnet = networkOf(state.settings) === 'solana:mainnet';
        return {
            wallet: account.address,
            symbol: (mint) => (!mainnet ? short(mint) : (KNOWN_SYMBOLS[mint] ?? verified.get(mint) ?? (cachedToken(mint)?.verified ? cachedToken(mint)!.symbol : short(mint)))),
            who: (a) => (a === account.address ? `${short(a)}${YOU}` : (names.get(a) ?? PROGRAM_NAMES.get(a) ?? short(a))),
            program: (a) => PROGRAM_NAMES.get(a) ?? short(a),
            known: [...state.accounts.map((k) => k.address), ...state.contacts.map((k) => k.address), ...(Object.keys(state.sent) as Address[])],
        };
    }, [account.address, held, state.accounts, state.contacts, state.sent, state.settings]);
    const list = useMemo(() => rows(once(read.data?.pages.flatMap((p) => p.rows) ?? []), naming), [read.data, naming]);
    const [open, setOpen] = useState<string | null>(null);
    const explorer = explorerOf(state.settings);

    // The next page, once the end of the list is in view.
    const end = useRef<HTMLDivElement>(null);
    const { hasNextPage, isFetching, fetchNextPage, isFetchNextPageError } = read;
    useEffect(() => {
        const at = end.current;
        if (!at || !hasNextPage || isFetching || isFetchNextPageError) return; // one read at a time, the first page's included
        const watch = new IntersectionObserver(([seen]) => void (seen.isIntersecting && fetchNextPage()));
        watch.observe(at);
        return () => watch.disconnect();
    }, [hasNextPage, isFetching, isFetchNextPageError, fetchNextPage, list.length]);

    const mark = <AccessMark state={state} go={go} />;
    return (
        <main className="flex h-full flex-col">
            <WalletBar state={state} go={go} />
            <section className="scroll flex min-h-0 flex-1 flex-col px-4 pt-1.5 pb-3.5">
                {list.length === 0 && <div className="flex justify-end pt-2.5">{mark}</div>}
                {!read.data && read.error && <Unread error={read.error} retry={() => void read.refetch()} settings={() => go('settings')} />}
                {read.data && list.length === 0 && <p className="pt-6 text-center text-[11px] text-ink-3">No transactions yet</p>}
                {days(list).map(([day, items], d) => (
                    <div key={day} className="day">
                        <div className="flex items-end justify-between">
                            <h2 className="pixel pt-4 pb-1.5 text-[10px] text-ink-2">{day}</h2>
                            {d === 0 && mark}
                        </div>
                        <ul>
                            {items.map((row, i) => {
                                const id = row.signature ?? `${day}#${i}`;
                                return <Item key={id} row={row} open={open === id} flip={() => setOpen(open === id ? null : id)} explorer={explorer} />;
                            })}
                        </ul>
                    </div>
                ))}
                {isFetchNextPageError && (
                    <p className="flex items-center justify-between gap-2 pt-3 text-[10.5px] text-warn">
                        {`Couldn't read more: ${said(read.error)}`}
                        <Button size="sm" onClick={() => void fetchNextPage()}>
                            Try again
                        </Button>
                    </p>
                )}
                <div ref={end} className="h-px shrink-0" />
            </section>
            <TabBar at="activity" go={go} />
        </main>
    );
}

// Who else has access, as a mark: green while only you can move your funds, amber once others can; Access on a click.
function AccessMark({ state, go }: { state: State; go: (to: Screen) => void }) {
    const read = useAccess(walletRpc(state.settings), current(state).address, state);
    const n = read.data ? others(read.data.grants) : null;
    const clean = n === 0 && !read.data?.unchecked; // green only when all was checked and no one else has access
    return (
        <Tip text="Check who can move your funds">
            <Button variant="ghost" size="icon" aria-label={n === null ? 'Check who can move your funds' : accessWords(n, read.data?.unchecked)} onClick={() => go('access')} className={cn('mb-1 size-7', n === null ? 'text-ink-3' : clean ? 'text-ok hover:text-ok' : 'text-warn hover:text-warn')}>
                <Icon name={n ? 'others' : 'only'} size={15} stroke={2.2} />
            </Button>
        </Tip>
    );
}

// Each transaction once, as pages read at different times may both hold one.
function once(list: (Activity | { unreadable: string })[]): (Activity | { unreadable: string })[] {
    const seen = new Set<string>();
    return list.filter((a) => !('signature' in a) || (!seen.has(a.signature) && !!seen.add(a.signature)));
}

// Why nothing could be read: an RPC that is not Helius', or one that did not answer.
function Unread({ error, retry, settings }: { error: Error; retry: () => void; settings: () => void }) {
    const helius = error instanceof NoHistory;
    return (
        <div className="flex flex-col items-center gap-2.5 pt-8 text-center">
            <p className="text-[11px] text-warn">{helius ? 'Activity needs a Helius RPC' : `The RPC did not answer: ${said(error)}`}</p>
            <Button size="sm" onClick={helius ? settings : retry}>
                {helius ? 'Settings' : 'Try again'}
            </Button>
        </div>
    );
}

// The rows by the day they landed, in order; one with no time stays with the day before it.
function days(list: Row[]): [string, Row[]][] {
    const out: [string, Row[]][] = [];
    for (const row of list) {
        const day = row.time === null ? (out.at(-1)?.[0] ?? 'Undated') : new Date(row.time * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        if (out.at(-1)?.[0] === day) out.at(-1)![1].push(row);
        else out.push([day, [row]]);
    }
    return out;
}

const TONE = { plain: '', warn: 'text-warn', danger: 'text-danger' } as const;
const WAY = { in: 'text-ok', out: 'text-danger' } as const;

// A line's words, what came in green and what went out red: in a plain row; a warning's colour holds over all of one.
const Parts = ({ parts, plain }: { parts: Part[]; plain: boolean }) => (
    <>
        {parts.map((p, i) => (
            <span key={i} className={cn(plain && p.way && WAY[p.way])}>
                <Tagged text={p.text} />
            </span>
        ))}
    </>
);
const DETAIL = { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger', dim: 'text-ink-3' } as const;

// One transaction: its line, and opened, all it told.
function Item({ row, open, flip, explorer }: { row: Row; open: boolean; flip: () => void; explorer: ReturnType<typeof explorerOf> }) {
    const when = row.time === null ? null : new Date(row.time * 1000);
    return (
        <li className="activity-row border-t border-dashed border-rule-2">
            <button type="button" aria-expanded={open} onClick={flip} className="flex min-h-[52px] w-full cursor-pointer items-center gap-3 py-2 text-left">
                <span className={cn('grid size-8 shrink-0 place-items-center rounded-[3px] border border-rule bg-panel', TONE[row.tone] || 'text-ink-2')}>
                    <Icon name={row.icon} size={14} stroke={2.2} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={cn('text-[12px] font-bold [overflow-wrap:anywhere]', TONE[row.tone])}>
                        <Parts parts={row.title} plain={row.tone === 'plain'} />
                    </span>
                    {row.sub.length > 0 && (
                        <span className={cn('truncate text-[10.5px]', row.tone === 'warn' ? 'text-warn' : 'text-ink-3')}>
                            <Parts parts={row.sub} plain={row.tone === 'plain'} />
                        </span>
                    )}
                </span>
                {when && <span className="shrink-0 self-start pt-0.5 text-[10.5px] text-ink-3">{when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>}
            </button>
            {open && (
                <div className="details flex flex-col gap-1 pb-3 pl-11 text-[11px]">
                    {row.details.map((d, i) => (
                        <span key={i} className={cn('[overflow-wrap:anywhere]', d.tone ? DETAIL[d.tone] : 'font-bold')}>
                            <Tagged text={d.text} />
                        </span>
                    ))}
                    {row.address && (
                        <span className="mt-1 flex flex-col gap-0.5">
                            <span className="pixel text-[9px] text-ink-3">{row.address.name ? `${row.address.label} · ${row.address.name}` : row.address.label}</span>
                            <span className="font-bold [overflow-wrap:anywhere]">
                                <span className={row.address.copy ? 'text-warn' : 'text-ok'}>{row.address.address.slice(0, 4)}</span>
                                {row.address.address.slice(4, -4)}
                                <span className={row.address.copy ? 'text-warn' : 'text-ok'}>{row.address.address.slice(-4)}</span>
                            </span>
                        </span>
                    )}
                    {when && <span className="mt-1 text-ink-3">{when.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
                    {row.signature && (
                        <a href={explorer.tx(row.signature)} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex h-7 items-center gap-1.5 self-start rounded-[3px] border border-rule px-[9px] text-[11px] font-bold text-ink hover:border-ink-3">
                            {`View on ${explorer.name}`}
                            <Icon name="external" size={11} stroke={2.5} />
                        </a>
                    )}
                </div>
            )}
        </li>
    );
}

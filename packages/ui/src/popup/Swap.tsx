// Swapping one of your tokens for another, at the price Jupiter routes it: asked through Otus's server, and quoted
// again every few seconds while the screen is open. Otus builds the swap from the route, and the background reviews it
// as any site's, guards included, then lands it through Helius Sender. Mainnet only: that is where Jupiter routes.
import { address, type Address } from '@solana/kit';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { isWrappedSol, USDC, WSOL } from '@otus-wallet/sdk/programs/addresses';
import { short } from '@otus-wallet/sdk/format';
import type { Holding } from '@otus-wallet/core/holdings.ts';
import { decimal, dollars } from '@otus-wallet/core/money.ts';
import { units as unitsOf } from '@otus-wallet/core/send/transfer.ts';
import { networkOf, OTUS_RPC, rpcFor, walletRpc } from '@otus-wallet/core/settings.ts';
import { signs, type State } from '@otus-wallet/core/state.ts';
import { fittingRoute, swapping } from '@otus-wallet/core/swap/build.ts';
import type { Route } from '@otus-wallet/core/swap/route.ts';
import { cachedToken, search, type TokenInfo } from '@otus-wallet/core/tokens.ts';
import { Icon } from '../components/icons.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { cn } from '../lib/cn.ts';
import type { Screen } from './App.tsx';
import { Bar, ErrorLine, Heading, Seal, Sheet, TokenLogo } from './common.tsx';
import { queries } from './query.ts';
import { current, said, useHoldings } from './store.ts';
import { Doing, type Job } from './TakeBack.tsx';

const SLIPPAGE = 50; // bps: the most the price may move against you between the quote and the swap
const RESERVE = 5_000_000n; // lamports Max leaves: the fee, the tip, and the rent of the token accounts a swap opens
const REQUOTE = 10_000; // ms between quotes while the screen is open
const LOOK_AFTER = 300; // ms after the last keystroke

/** A token on one side: what the screen shows of it, and its mint (wrapped SOL's for SOL, which Jupiter wraps). */
type Side = { mint: Address; symbol: string; name: string; icon: string | null; verified: boolean; decimals: number; price: number | null };

const SOL: Side = { mint: WSOL, symbol: 'SOL', name: 'Solana', icon: null, verified: true, decimals: 9, price: null };
const USD_COIN: Side = { mint: USDC, symbol: 'USDC', name: 'USD Coin', icon: null, verified: true, decimals: 6, price: null };
const sideOf = (a: Holding): Side => ({ mint: address(a.native ? WSOL : a.mint), symbol: a.native ? 'SOL' : a.symbol || short(a.mint), name: a.name, icon: a.verified ? a.icon : null, verified: a.verified, decimals: a.decimals, price: a.price });
// Only a verified token's icon is fetched, as everywhere in Otus: anyone can put any address in an unverified one's.
const sideFrom = (t: TokenInfo): Side | null => (t.decimals === null ? null : { mint: address(t.id), symbol: t.symbol || short(t.id), name: t.name, icon: t.verified ? t.icon : null, verified: t.verified, decimals: t.decimals, price: t.usdPrice });

export function SwapScreen({ state, go }: { state: State; go: (to: Screen) => void }) {
    const account = current(state);
    const mainnet = networkOf(state.settings) === 'solana:mainnet';
    const held = useHoldings(walletRpc(state.settings), account.address, mainnet);
    const [pay, setPay] = useState<Side>(SOL);
    const [get, setGet] = useState<Side>(USD_COIN);
    const [text, setText] = useState('');
    const [picking, setPicking] = useState<'pay' | 'get' | null>(null);
    const [doing, setDoing] = useState<{ job: Job; title: string } | null>(null);
    // What you can pay with: SOL, and every token you hold some of (wrapped SOL in a token account aside: Jupiter takes
    // SOL itself, and wraps it).
    const mine = useMemo(() => (held && !(held instanceof Error) ? held.assets.filter((a) => a.native || (a.units > 0n && a.source && !isWrappedSol(a.mint))) : []), [held]);
    const holding = (s: Side) => mine.find((a) => sideOf(a).mint === s.mint);
    const payHeld = holding(pay);
    const available = !payHeld ? 0n : payHeld.native ? (payHeld.units > RESERVE ? payHeld.units - RESERVE : 0n) : (payHeld.source?.units ?? 0n);
    const units = unitsOf(text.trim(), pay.decimals);
    const asked = useSettled(units, LOOK_AFTER);
    const problem = problemOf({ text: text.trim(), units, available, pay, get, known: held !== undefined && !(held instanceof Error) });
    const quote = useQuery({
        queryKey: ['route', account.address, pay.mint, get.mint, String(asked)],
        queryFn: () => fittingRoute({ input: pay.mint, output: get.mint, amount: asked!, taker: account.address, slippageBps: SLIPPAGE }),
        enabled: mainnet && asked !== null && asked === units && !problem,
        refetchInterval: REQUOTE,
        staleTime: REQUOTE,
        retry: 1,
        placeholderData: keepPreviousData,
    });
    const route = quote.data && quote.data.ask.amount === units && quote.data.ask.input === pay.mint && quote.data.ask.output === get.mint ? quote.data : null;

    if (doing) {
        const done = (landed: boolean) => {
            setDoing(null);
            void queries.invalidateQueries({ queryKey: ['holdings'] });
            if (landed) go('activity');
        };
        return <Doing account={account} job={doing.job} title={doing.title} settings={state.settings} done={done} />;
    }
    if (picking) {
        const set = picking === 'pay' ? setPay : setGet;
        return <TokenPick title={picking === 'pay' ? 'You pay' : 'You get'} held={mine} findMore={picking === 'get'} throughOtus={rpcFor('solana:mainnet', state.settings) === OTUS_RPC} pick={(s) => (set(s), setPicking(null), picking === 'pay' && setText(''))} back={() => setPicking(null)} />;
    }
    const bar = <Bar title="Swap" back={() => go('lobby')} />;
    if (!mainnet || !signs(account)) {
        return (
            <Sheet bar={bar}>
                <p className="pt-4 text-center text-[11px] text-ink-3">{!mainnet ? 'Swaps are on mainnet only.' : 'Watch only: Otus holds no key for it.'}</p>
            </Sheet>
        );
    }
    const swap = () => {
        if (!route) return;
        let first: Route | null = route; // the route quoted; a try again asks for a fresh one
        const job: Job = {
            kind: 'swap',
            make: async (lifetime) => {
                const r = first ?? (await fittingRoute({ input: route.ask.input, output: route.ask.output, amount: route.ask.amount, taker: route.ask.taker, slippageBps: SLIPPAGE }));
                first = null;
                return swapping(r, lifetime);
            },
            doing: 'Swapping',
            landed: 'Swapped',
            where: 'Activity',
        };
        setDoing({ job, title: `${decimal(route.ask.amount, pay.decimals)} ${pay.symbol} for ${get.symbol}` });
    };
    const flip = () => (setPay(get), setGet(pay), setText(''));
    // At its price, as your balances or Jupiter last said it.
    const value = (s: Side, u: bigint) => {
        const price = holding(s)?.price ?? s.price ?? cachedToken(s.mint)?.usdPrice ?? null;
        return price === null ? null : (Number(u) / 10 ** s.decimals) * price;
    };
    const paid = units !== null ? value(pay, units) : null;
    const got = route ? value(get, route.out) : null;
    return (
        <Sheet bar={bar} foot={<Foot disabled={!route || Boolean(problem)} onClick={swap} />}>
            <div className="flex flex-col gap-1.5">
                <Heading
                    extra={
                        available > 0n && (
                            <Button size="xs" onClick={() => setText(decimal(available, pay.decimals))}>
                                Max
                            </Button>
                        )
                    }
                >
                    You pay
                </Heading>
                <div className="flex gap-1.5">
                    <TokenButton side={pay} onClick={() => setPicking('pay')} />
                    <Input inputMode="decimal" placeholder="0" autoComplete="off" spellCheck={false} aria-label="Amount" autoFocus className="min-w-0 flex-1 text-right" value={text} onChange={(e) => setText(e.target.value)} />
                </div>
                <p className="text-right text-[10.5px] text-ink-3">{[payHeld ? `${decimal(payHeld.units, payHeld.decimals)} held` : 'None held', paid !== null && `≈ ${dollars(paid)}`].filter(Boolean).join(' · ')}</p>
            </div>
            <button type="button" aria-label="Flip" onClick={flip} className="-my-2 grid size-7 cursor-pointer place-items-center self-center rounded-[3px] border border-rule text-ink-2 hover:border-ink-3 hover:text-ink">
                <Icon name="swap" size={14} className="rotate-90" />
            </button>
            <div className="flex flex-col gap-1.5">
                <Heading>You get</Heading>
                <div className="flex items-center gap-1.5">
                    <TokenButton side={get} onClick={() => setPicking('get')} />
                    <p className={cn('min-w-0 flex-1 truncate text-right text-base font-bold', !route && 'text-ink-3')}>{route ? decimal(route.out, get.decimals) : '0'}</p>
                </div>
                {route && (
                    <p className="text-right text-[10.5px] text-ink-3">{[got !== null && `≈ ${dollars(got)}`, `at least ${decimal(route.least, get.decimals)}`, `via ${[...new Set(route.venues.map((v) => v.label))].join(', ')}`].filter(Boolean).join(' · ')}</p>
                )}
                {!get.verified && <p className="text-[10.5px] text-warn">{`${get.symbol} is not verified: check its address, ${short(get.mint)}`}</p>}
            </div>
            <ErrorLine>{problem || (quote.error && !route ? said(quote.error) : '')}</ErrorLine>
        </Sheet>
    );
}

const Foot = ({ disabled, onClick }: { disabled: boolean; onClick: () => void }) => (
    <div className="border-t border-dashed border-rule px-4 pt-2.5 pb-3.5">
        <Button variant="default" className="w-full" disabled={disabled} onClick={onClick}>
            Swap
        </Button>
    </div>
);

// A side's token, to pick another.
const TokenButton = ({ side, onClick }: { side: Side; onClick: () => void }) => (
    <button type="button" aria-label={`Token: ${side.symbol}`} onClick={onClick} className="flex h-[34px] shrink-0 cursor-pointer items-center gap-1.5 rounded-[3px] border border-rule bg-panel px-2 text-xs font-bold hover:border-ink-3">
        <TokenLogo asset={side} size={18} />
        {side.symbol}
        <Icon name="down" size={12} className="text-ink-3" />
    </button>
);

// Picking a side's token: yours first, by name or address; for what you get, also those Jupiter finds: by name only the
// verified ones, which keeps out the many that borrow a known name, and any token by its exact address.
function TokenPick({ title, held, findMore, throughOtus, pick, back }: { title: string; held: Holding[]; findMore: boolean; throughOtus: boolean; pick: (s: Side) => void; back: () => void }) {
    const [query, setQuery] = useState('');
    const words = useSettled(query.trim(), LOOK_AFTER);
    const found = useQuery({ queryKey: ['token-search', words, throughOtus], queryFn: () => search(words, throughOtus), enabled: findMore && words.length > 0, staleTime: 60_000 });
    const q = query.trim().toLowerCase();
    const yours = held.map(sideOf).filter((s) => !q || s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.mint === query.trim());
    const others = (found.data ?? []).flatMap((t) => sideFrom(t) ?? []).filter((s) => (s.verified || s.mint === query.trim()) && !yours.some((y) => y.mint === s.mint));
    const sides = q || !findMore ? [...yours, ...others] : [...yours, ...(yours.some((y) => y.mint === USDC) ? [] : [USD_COIN]), ...(yours.some((y) => y.mint === WSOL) ? [] : [SOL])];
    return (
        <Sheet bar={<Bar title={title} back={back} />}>
            <Input placeholder="Name or address" autoComplete="off" spellCheck={false} aria-label="Find a token" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} />
            <ul className="flex flex-col">
                {sides.map((s) => (
                    <li key={s.mint}>
                        <button type="button" onClick={() => pick(s)} className="flex w-full cursor-pointer items-center gap-2.5 border-t border-dashed border-rule-2 py-2 text-left first:border-t-0">
                            <TokenLogo asset={s} size={24} />
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="flex items-center gap-1.5 text-xs font-bold">
                                    {s.symbol}
                                    {s.verified && <Seal symbol={s.symbol} />}
                                </span>
                                <span className="truncate text-[10.5px] text-ink-3">{`${s.name || s.symbol} · ${short(s.mint)}`}</span>
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
            {findMore && q && found.isError && <ErrorLine>{said(found.error)}</ErrorLine>}
            {q && sides.length === 0 && !found.isFetching && <p className="text-[11px] text-ink-3">No token by that name or address</p>}
        </Sheet>
    );
}

// What keeps the swap from going on, in words, checked in the order the screen reads; empty when nothing does.
function problemOf(f: { text: string; units: bigint | null; available: bigint; pay: Side; get: Side; known: boolean }): string {
    if (f.pay.mint === f.get.mint) return 'The same token on both sides';
    if (f.text.includes(',')) return 'Use a point for decimals: 0.05, not 0,05';
    if (f.text && f.units === null) return `An amount above 0, with at most ${f.pay.decimals} decimals`;
    if (f.known && f.units !== null && f.units > f.available) return f.pay.symbol === 'SOL' ? `At most ${decimal(f.available, 9)} SOL: some stays for fees` : `More than you hold of ${f.pay.symbol}`;
    return '';
}

// A value once it stops changing for `ms`.
function useSettled<T>(value: T, ms: number): T {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setSettled(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return settled;
}

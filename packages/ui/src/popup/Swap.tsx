// Swapping one of your tokens for another, at the price Jupiter routes it: asked through Otus's server, and quoted
// again every few seconds while the screen is open. Otus builds the swap from the route, and the background reviews it
// as any site's, guards included, then lands it through Helius Sender. Mainnet only: that is where Jupiter routes.
import { address, type Address } from '@solana/kit';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type InputHTMLAttributes, type ReactNode } from 'react';

import { isWrappedSol, USDC, WSOL } from '@otus-wallet/sdk/programs/addresses';
import { short } from '@otus-wallet/sdk/format';
import type { Holding } from '@otus-wallet/core/holdings.ts';
import { decimal, dollars } from '@otus-wallet/core/money.ts';
import { units as unitsOf } from '@otus-wallet/core/send/transfer.ts';
import { networkOf, OTUS_RPC, rpcFor, walletRpc } from '@otus-wallet/core/settings.ts';
import { signs, type State } from '@otus-wallet/core/state.ts';
import { fittingRoute, swapping } from '@otus-wallet/core/swap/build.ts';
import type { Route } from '@otus-wallet/core/swap/route.ts';
import { askedWire } from '@otus-wallet/core/swap/terms.ts';
import { cachedToken, search, type TokenInfo } from '@otus-wallet/core/tokens.ts';
import { Icon } from '../components/icons.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { cn } from '../lib/cn.ts';
import type { Screen } from './App.tsx';
import { Bar, ErrorLine, Seal, Sheet, TokenLogo } from './common.tsx';
import { forgetActivity, queries } from './query.ts';
import { current, said, useHoldings } from './store.ts';
import { Doing, type Job } from './TakeBack.tsx';

const SLIPPAGE = 50; // bps: the most the price may move against you between the quote and the swap
// Lamports Max leaves when paying SOL: the rent of the two token accounts a swap may open (wrapped SOL's comes back),
// the fee, the most priority fee Otus sets, and the tip.
const RESERVE = 6_000_000n;
const FOR_FEES = 3_000_000n; // lamports a swap paid in a token needs: one account's rent, the fee, priority fee and tip
const REQUOTE = 10_000; // ms between quotes while the screen is open
const FRESH = REQUOTE + 2_000; // ms a quote counts: an older one is asked again before it is built
const LOOK_AFTER = 300; // ms after the last keystroke
const NOTABLE = 1; // percent of price impact said, as a warning
const HEAVY = 10; // percent of price impact said as danger, and swapped only "anyway"

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
    // A token you hold counts its decimals as your balances read them from its mint.
    const payDecimals = payHeld?.decimals ?? pay.decimals;
    const getDecimals = holding(get)?.decimals ?? get.decimals;
    const available = !payHeld ? 0n : payHeld.native ? (payHeld.units > RESERVE ? payHeld.units - RESERVE : 0n) : (payHeld.source?.units ?? 0n);
    const units = unitsOf(text.trim(), payDecimals);
    const asked = useSettled(units, LOOK_AFTER);
    const read = held === undefined || held instanceof Error ? null : held;
    const problem = problemOf({ text: text.trim(), units, available, pay, get, decimals: payDecimals, sol: read?.sol ?? null });
    const quote = useQuery({
        queryKey: ['route', account.address, pay.mint, get.mint, String(asked)],
        queryFn: () => fittingRoute({ input: pay.mint, output: get.mint, amount: asked!, taker: account.address, slippageBps: SLIPPAGE }),
        enabled: mainnet && read !== null && asked !== null && asked === units && !problem && !doing && !picking,
        refetchInterval: REQUOTE,
        staleTime: REQUOTE,
        gcTime: 0, // a quote for another amount or token is never shown again
        retry: 1,
        placeholderData: keepPreviousData,
    });
    // The quote for what is typed now, by this wallet, and fresh: another, or an old one, is never swapped.
    const r = quote.data;
    const route = r && !quote.isPlaceholderData && Date.now() - quote.dataUpdatedAt < FRESH && r.ask.amount === units && r.ask.input === pay.mint && r.ask.output === get.mint && r.ask.taker === account.address ? r : null;
    const quotedAt = quote.dataUpdatedAt;

    if (doing) {
        // Gone out (on its way, landed, or not confirmed yet): what it moved shows in Activity, and the amount is cleared,
        // so that it is not swapped twice by mistake.
        const done = (landed: boolean, gone = landed) => {
            setDoing(null);
            setText('');
            void queries.invalidateQueries({ queryKey: ['holdings'] });
            if (!gone) return;
            void queries.resetQueries({ queryKey: ['activity'] });
            forgetActivity();
            go('activity');
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
        // The route quoted, while fresh; a try again, or a review that came late, asks for a new one. The background is
        // told what the one built was asked for, and holds the swap to it.
        let first: Route | null = route;
        let built: Route = route;
        const job: Job = {
            kind: 'swap',
            make: async (lifetime) => {
                const fresh = first && Date.now() - quotedAt < FRESH ? first : null;
                first = null;
                built = fresh ?? (await fittingRoute({ input: route.ask.input, output: route.ask.output, amount: route.ask.amount, taker: route.ask.taker, slippageBps: SLIPPAGE }));
                return swapping(built, lifetime);
            },
            asked: () => askedWire({ input: built.ask.input, output: built.ask.output, amount: built.ask.amount, out: built.out, slippageBps: built.ask.slippageBps }),
            doing: 'Swapping',
            landed: 'Swapped',
            where: 'Activity',
        };
        setDoing({ job, title: `${decimal(route.ask.amount, payDecimals)} ${pay.symbol} for ${get.symbol}` });
    };
    const flip = () => (setPay(get), setGet(pay), setText(''));
    // At its price, as your balances or Jupiter last said it; a verified token's only: anyone can make an unverified
    // one's price with a pool of their own.
    const value = (s: Side, u: bigint, decimals: number) => {
        const price = (holding(s)?.verified ?? s.verified) ? (holding(s)?.price ?? s.price ?? cachedToken(s.mint)?.usdPrice ?? null) : null;
        return price === null ? null : (Number(u) / 10 ** decimals) * price;
    };
    const paid = units !== null ? value(pay, units, payDecimals) : null;
    const got = route ? value(get, route.out, getDecimals) : null;
    const impact = route?.impact ?? null;
    const heavy = impact !== null && impact >= HEAVY;
    return (
        <Sheet bar={bar} foot={<Foot disabled={!route || Boolean(problem)} anyway={heavy} onClick={swap} />} className="gap-2.5">
            <Pane
                label="You pay"
                extra={
                    <span className="flex items-center gap-2 text-[10.5px] text-ink-3">
                        {heldWords(held, payHeld)}
                        {available > 0n && (
                            <Button size="xs" onClick={() => setText(decimal(available, payDecimals))}>
                                Max
                            </Button>
                        )}
                    </span>
                }
                amount={<Amount aria-label="Amount" autoFocus value={text} onChange={(e) => setText(e.target.value)} />}
                token={<TokenButton side={pay} onClick={() => setPicking('pay')} />}
                worth={paid !== null ? `≈ ${dollars(paid)}` : ''}
            />
            <button type="button" aria-label="Flip" onClick={flip} className="z-10 -my-[19px] grid size-8 cursor-pointer place-items-center self-center rounded-md border border-rule bg-black text-ink-2 hover:border-ink-3 hover:text-ink">
                <Icon name="swap" size={14} className="rotate-90" />
            </button>
            <Pane
                label="You get"
                amount={<Amount aria-label="You get" readOnly tabIndex={-1} value={route ? decimal(route.out, getDecimals) : ''} />}
                token={<TokenButton side={get} onClick={() => setPicking('get')} />}
                worth={got !== null ? `≈ ${dollars(got)}` : ''}
            />
            {route && (
                <dl className="flex flex-col gap-1.5 rounded-md border border-rule px-3.5 py-2.5 text-[10.5px]">
                    <Fact name="Rate">{`1 ${pay.symbol} ≈ ${rate(route, payDecimals, getDecimals)} ${get.symbol}`}</Fact>
                    <Fact name="Slippage">{`${route.ask.slippageBps / 100}%`}</Fact>
                    <Fact name="At least">{`${decimal(route.least, getDecimals)} ${get.symbol}`}</Fact>
                    <Fact name="Route">{[...new Set(route.venues.map((v) => v.label))].join(', ')}</Fact>
                </dl>
            )}
            {impact !== null && impact >= NOTABLE && <p className={cn('text-[10.5px]', heavy ? 'text-danger' : 'text-warn')}>{`Price impact ${impact.toFixed(impact < 10 ? 1 : 0)}%: you get that much less than the market price`}</p>}
            {!get.verified && <p className="text-[10.5px] text-warn">{`${get.symbol} is not verified: check its address, ${short(get.mint)}`}</p>}
            <ErrorLine>{problem || (quote.isError ? said(quote.error) : '')}</ErrorLine>
        </Sheet>
    );
}

// One side of the swap in its own box: what it is, the amount and the token side by side, and what it is worth.
const Pane = ({ label, extra, amount, token, worth }: { label: string; extra?: ReactNode; amount: ReactNode; token: ReactNode; worth: string }) => (
    <div className="flex flex-col gap-1.5 rounded-md border border-rule bg-panel px-3.5 pt-2.5 pb-2 transition-[box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <div className="flex h-5 items-center justify-between">
            <span className="pixel text-[10px] text-ink-2">{label}</span>
            {extra}
        </div>
        <div className="flex items-center gap-2">
            {amount}
            {token}
        </div>
        <p className="h-4 text-[10.5px] text-ink-3">{worth}</p>
    </div>
);

// An amount as a pane shows it: large, left, borderless; read only on the side the quote fills.
const Amount = (props: InputHTMLAttributes<HTMLInputElement>) => (
    <input inputMode="decimal" placeholder="0" autoComplete="off" spellCheck={false} {...props} className="min-w-0 flex-1 bg-transparent text-[22px] leading-8 font-bold outline-none placeholder:text-ink-3 read-only:cursor-default" />
);

// One line of the quote's facts: its name, and what it says.
const Fact = ({ name, children }: { name: string; children: ReactNode }) => (
    <div className="flex items-baseline justify-between gap-3">
        <dt className="shrink-0 text-ink-3">{name}</dt>
        <dd className="min-w-0 truncate text-right text-ink-2">{children}</dd>
    </div>
);

// How much one of what you pay brings of what you get, at the quote: shown with up to six significant digits.
function rate(route: Route, payDecimals: number, getDecimals: number): string {
    const one = Number(route.out) / 10 ** getDecimals / (Number(route.ask.amount) / 10 ** payDecimals);
    return one.toLocaleString('en-US', { maximumSignificantDigits: 6 });
}

const Foot = ({ disabled, anyway, onClick }: { disabled: boolean; anyway: boolean; onClick: () => void }) => (
    <div className="border-t border-dashed border-rule px-4 pt-2.5 pb-3.5">
        <Button variant="default" className="w-full" disabled={disabled} onClick={onClick}>
            {anyway ? 'Swap anyway' : 'Swap'}
        </Button>
    </div>
);

// What you hold of the token you pay with, or why it is not known.
function heldWords(held: ReturnType<typeof useHoldings>, h: Holding | undefined): string {
    if (held === undefined) return 'Reading your balances';
    if (held instanceof Error) return `Your RPC did not answer: ${said(held)}`;
    return h ? `${decimal(h.units, h.decimals)} held` : 'None held';
}

// A side's token, to pick another.
const TokenButton = ({ side, onClick }: { side: Side; onClick: () => void }) => (
    <button type="button" aria-label={`Token: ${side.symbol}`} onClick={onClick} className="flex h-[34px] min-w-[108px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-rule bg-black px-2.5 text-xs font-bold hover:border-ink-3">
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
    const results = findMore ? (found.data ?? []) : []; // what you pay with is only what you hold
    const q = query.trim().toLowerCase();
    const yours = held.map(sideOf).filter((s) => !q || s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.mint === query.trim());
    const others = results.flatMap((t) => sideFrom(t) ?? []).filter((s) => (s.verified || s.mint === query.trim()) && !yours.some((y) => y.mint === s.mint));
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

// What keeps the swap from going on, in words, checked in the order the screen reads; empty when nothing does. `sol`:
// what the wallet holds, once read.
function problemOf(f: { text: string; units: bigint | null; available: bigint; pay: Side; get: Side; decimals: number; sol: bigint | null }): string {
    if (f.pay.mint === f.get.mint) return 'The same token on both sides';
    if (f.text.includes(',')) return 'Use a point for decimals: 0.05, not 0,05';
    if (f.text && f.units === null) return `An amount above 0, with at most ${f.decimals} decimals`;
    if (f.sol === null || f.units === null) return '';
    const paysSol = f.pay.mint === WSOL;
    if (f.units > f.available) return paysSol ? `At most ${decimal(f.available, 9)} SOL: some stays for fees` : `More than you hold of ${f.pay.symbol}`;
    if (!paysSol && f.sol < FOR_FEES) return `Keep at least ${decimal(FOR_FEES, 9)} SOL for the fees`;
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

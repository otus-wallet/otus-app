// Pieces every screen of the popup uses: its frame, headings, tooltips, copying, a token's logo and seal, a price move.
import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '../components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip.tsx';
import { Icon, Logo } from '../components/icons.tsx';
import { USDC, USDT, WSOL, type Holding } from '@otus-wallet/core/holdings.ts';
import { cn } from '../lib/cn.ts';
import type { Screen } from './App.tsx';
import { outsideKey } from '@otus-wallet/core/outside.ts';
import { networkOf } from '@otus-wallet/core/settings.ts';
import type { State } from '@otus-wallet/core/state.ts';
import { current } from './store.ts';
import { trendOf } from '@otus-wallet/core/money.ts';

/** A screen: its bar on top, then a body that scrolls, and what stays at the bottom. */
export function Sheet({ bar, children, className, foot }: { bar: ReactNode; children: ReactNode; className?: string; foot?: ReactNode }) {
    return (
        <main className="flex h-full flex-col">
            {bar}
            <section className={cn('scroll flex min-h-0 flex-1 flex-col gap-[18px] px-4 pt-1.5 pb-3.5', className)}>{children}</section>
            {foot}
        </main>
    );
}

/** The bar of a screen: its name in the pixel font, and back, under the lobby. */
export function Bar({ title, back }: { title: string; back?: () => void }) {
    return (
        <header className="flex items-center gap-1 border-b border-dashed border-rule px-2.5 pt-2.5 pb-2">
            {back ? <IconButton name="left" label="Back" onClick={back} /> : <span className="size-8" />}
            <h1 className="pixel flex-1 text-center text-lg">{title}</h1>
            <span className="size-8" />
        </header>
    );
}

/** The bar at the bottom of the lobby, Activity and Settings: one tap from each to the others. */
/** Home, Activity, Settings. Activity bears an amber dot while it holds transactions the wallet signed outside Otus
 *  that it has not shown yet. */
export function TabBar({ at, go, state }: { at: 'lobby' | 'activity' | 'settings'; go: (to: Screen) => void; state: State }) {
    const outside = state.outside[outsideKey(networkOf(state.settings), current(state).address)]?.unseen === true;
    const tabs = [
        ['lobby', 'home', 'Home'],
        ['activity', 'history', 'Activity'],
        ['settings', 'gear', 'Settings'],
    ] as const;
    return (
        <nav className="tabs flex shrink-0 border-t border-dashed border-rule">
            {tabs.map(([to, icon, label]) => (
                <button
                    key={to}
                    type="button"
                    aria-current={at === to ? 'page' : undefined}
                    onClick={() => at !== to && go(to)}
                    className={cn('flex h-[52px] flex-1 cursor-pointer flex-col items-center justify-center gap-[5px]', at === to ? 'text-ink' : 'text-ink-3 hover:text-ink-2')}
                >
                    <span className="relative">
                        <Icon name={icon} size={16} stroke={2.2} />
                        {to === 'activity' && outside && <span aria-label="Signed outside Otus" className="outside absolute -top-[3px] -right-[5px] size-[7px] rounded-full bg-warn" />}
                    </span>
                    <span className="pixel text-xs tracking-[0.04em]">{label}</span>
                </button>
            ))}
        </nav>
    );
}

export function IconButton({ name, label, onClick, className }: { name: Parameters<typeof Icon>[0]['name']; label: string; onClick: () => void; className?: string }) {
    return (
        <Button variant="ghost" size="icon" aria-label={label} onClick={onClick} className={className}>
            <Icon name={name} size={16} stroke={2.5} />
        </Button>
    );
}

/** An address copied with a click, with a check for a moment. */
export function CopyAddress({ address, label = 'Copy address', className }: { address: string; label?: string; className?: string }) {
    const [done, setDone] = useState(false);
    useEffect(() => {
        if (!done) return;
        const t = setTimeout(() => setDone(false), 1500);
        return () => clearTimeout(t);
    }, [done]);
    return <IconButton name={done ? 'check' : 'copy'} label={label} className={cn(className, done && 'text-ok hover:text-ok')} onClick={() => navigator.clipboard.writeText(address).then(() => setDone(true))} />;
}

/** One line of facts, in a <dl>: its name, and what it says, on one line or, `wrap`, on as many as it takes. */
export const Fact = ({ name, children, wrap = false }: { name: string; children: ReactNode; wrap?: boolean }) => (
    <div className="flex items-baseline justify-between gap-3">
        <dt className="shrink-0 text-ink-3">{name}</dt>
        <dd className={cn('min-w-0 text-right text-ink-2', wrap ? '[overflow-wrap:anywhere]' : 'truncate')}>{children}</dd>
    </div>
);

/** A heading in the pixel font, with something on its right. */
export function Heading({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-2">
            <h2 className="pixel text-xs text-ink-2">{children}</h2>
            {extra}
        </div>
    );
}

/** A tooltip, for what is not plain from the thing itself. A line break splits a bold title from the text under it. */
export function Tip({ text, children }: { text: string; children: ReactNode }) {
    const [title, ...rest] = text.split('\n');
    return (
        <Tooltip>
            <TooltipTrigger asChild>{children}</TooltipTrigger>
            <TooltipContent sideOffset={6} collisionPadding={8}>
                {rest.length ? <strong className="block text-xs text-ink">{title}</strong> : title}
                {rest.map((line) => (
                    <span key={line} className="block">
                        {line}
                    </span>
                ))}
            </TooltipContent>
        </Tooltip>
    );
}

/** Copies a text, and says so on the button for a moment. */
export function CopyButton({ text, label = 'Copy', size = 'sm', onCopy }: { text: () => string; label?: string; size?: 'sm' | 'default'; onCopy?: () => void }) {
    const [done, setDone] = useState(false);
    useEffect(() => {
        if (!done) return;
        const t = setTimeout(() => setDone(false), 1500);
        return () => clearTimeout(t);
    }, [done]);
    const copy = async () => {
        await navigator.clipboard.writeText(text());
        onCopy?.();
        setDone(true);
    };
    return (
        <Button size={size} onClick={copy}>
            <Icon name={done ? 'check' : 'copy'} size={13} stroke={done ? 2.5 : 2} />
            {done ? 'Copied' : label}
        </Button>
    );
}

/** How a price moved over a day: up in green, down in red, flat in grey. */
export function Trend({ change, className }: { change: number; className?: string }) {
    const { shown, way } = trendOf(change);
    const tone = { up: 'border-ok-bd bg-ok-bg text-ok', down: 'border-danger-bd bg-danger-bg text-danger', flat: 'border-rule text-ink-3' }[way];
    return <span className={cn('rounded-[3px] border px-1.5 py-px text-2xs font-bold whitespace-nowrap', tone, className)}>{`${way === 'up' ? '▲ ' : way === 'down' ? '▼ ' : ''}${shown}%`}</span>;
}

/** The seal of a verified token, saying so on hover. */
export function Seal({ symbol, size = 9 }: { symbol: string; size?: number }) {
    return (
        <Tip text="This is a verified, widely used token.">
            <span tabIndex={0} role="img" aria-label={`Verified ${symbol}`} className="verified inline-grid size-3.5 shrink-0 cursor-help place-items-center rounded-sm border border-ok bg-ok-bg text-ok">
                <Icon name="check" size={size} stroke={3.5} />
            </span>
        </Tip>
    );
}

/** SOL, USDC and USDT from the extension's own logos; another verified token from its icon; anything else, the chain's
 *  mark in grey. Only a verified token's icon is fetched, from where its makers keep it, without cookies or saying which
 *  page asks. */
export function TokenLogo({ asset, size = 28 }: { asset: Pick<Holding, 'mint' | 'icon'>; size?: number }) {
    const [failed, setFailed] = useState(false);
    const mark = asset.mint === WSOL ? 'sol' : asset.mint === USDC ? 'usdc' : asset.mint === USDT ? 'usdt' : null;
    if (mark) return <Logo name={mark} size={size} className="rounded-[3px] bg-panel" />;
    if (!asset.icon || failed) return <Logo name="chain" size={size} className="rounded-[3px] bg-panel text-ink-3" />;
    return <img src={asset.icon} alt="" width={size} height={size} crossOrigin="anonymous" referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed(true)} className="shrink-0 rounded-[3px] bg-panel object-cover" />;
}

/** One of a few choices side by side, the one on marked. */
export const Choice = ({ text, on, onClick }: { text: string; on: boolean; onClick: () => void }) => (
    <button type="button" aria-pressed={on} onClick={onClick} className={cn('h-7 cursor-pointer rounded-[3px] border px-[9px] text-xs font-bold', on ? 'border-ok-bd bg-ok-bg text-ok' : 'border-rule text-ink-2 hover:border-ink-3')}>
        {text}
    </button>
);

export const ErrorLine = ({ children }: { children: ReactNode }) =>
    children ? (
        <p role="alert" className="text-xs text-danger">
            {children}
        </p>
    ) : null;

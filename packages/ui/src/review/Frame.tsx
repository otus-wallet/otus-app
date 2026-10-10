// What every approval window has: who asks and for which account, the steps of a transaction, a body that scrolls,
// the answers. And the waiting buttons: those that approve or move on take clicks only a moment after the window shows,
// comes to the front, moves, changes size or changes step, and once the pointer really moves after that (or Tab is
// pressed), so a burst of clicks a site asked for elsewhere, at a pointer standing still, cannot land on them.
import { useEffect, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

import { Button } from '../components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip.tsx';
import { Icon } from '../components/icons.tsx';
import { plural } from '@otus-wallet/sdk/format';
import { short } from '../dom.ts';
import { cn } from '../lib/cn.ts';
import type { AccountView, SiteView, Tone } from '@otus-wallet/core/view.ts';
import { filled, MARK, text } from './tone.ts';

const ARMING = 150; // ms

/**
 * False for a moment after the window shows, comes to the front, moves or changes size, and after each change of
 * `step`; then until the pointer moves, or Tab is pressed (a tap counts too, but not on the button it would arm). Worked
 * out while drawing, so the render
 * that shows a new step or follows the focus is already unarmed: a click queued right behind them finds the buttons
 * disabled.
 */
export function useArmed(step: unknown): boolean {
    const [focused, setFocused] = useState(0);
    // Every change of step counts, back to a step armed before included.
    const [seen, setSeen] = useState({ step, changes: 0 });
    let { changes } = seen;
    if (!Object.is(seen.step, step)) {
        changes += 1;
        setSeen({ step, changes });
    }
    const [armedFor, setArmedFor] = useState<{ changes: number; focused: number } | null>(null);
    useEffect(() => {
        const again = () => flushSync(() => setFocused((n) => n + 1)); // drawn within the event itself
        addEventListener('focus', again);
        addEventListener('resize', again);
        // Moved, as another extension can move it under the pointer: as if it came to the front again.
        let at = [screenX, screenY];
        const watch = setInterval(() => {
            if (screenX === at[0] && screenY === at[1]) return;
            at = [screenX, screenY];
            again();
        }, 100);
        return () => {
            removeEventListener('focus', again);
            removeEventListener('resize', again);
            clearInterval(watch);
        };
    }, []);
    useEffect(() => {
        let waited = false;
        const stir = (e: PointerEvent | KeyboardEvent) => {
            if (!waited) return;
            const tap = e.type === 'pointerdown' && (e as PointerEvent).pointerType !== 'mouse' && !(e.target instanceof Element && e.target.closest('[data-arms]'));
            const moved = e instanceof KeyboardEvent ? e.key === 'Tab' : tap || e.movementX !== 0 || e.movementY !== 0;
            if (moved) setArmedFor((a) => (a?.changes === changes && a.focused === focused ? a : { changes, focused }));
        };
        const t = setTimeout(() => (waited = true), ARMING);
        for (const kind of ['pointermove', 'pointerdown', 'keydown'] as const) addEventListener(kind, stir);
        return () => {
            clearTimeout(t);
            for (const kind of ['pointermove', 'pointerdown', 'keydown'] as const) removeEventListener(kind, stir);
        };
    }, [changes, focused]);
    return armedFor !== null && armedFor.changes === changes && armedFor.focused === focused;
}

/** The time now, read again every `every` ms; null reads it once. */
export function useNow(every: number | null): number {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (every === null) return;
        const t = setInterval(() => setNow(Date.now()), every);
        return () => clearInterval(t);
    }, [every]);
    return now;
}

/**
 * `page`: the step shown; a new one starts at the top of the body. `left`: the time left to sign, centered between the
 * site and the account. `chip`: the verdict, under the site in place of what is known of it (the verdict says that too).
 */
export function Frame({ site, account, picker, network, steps, page, left, chip, children, actions }: { site: SiteView; account: AccountView; picker?: ReactNode; network: string | null; steps?: ReactNode; page?: number; left?: ReactNode; chip?: { text: string; tone: Tone }; children: ReactNode; actions: ReactNode }) {
    const where = network && <span className="font-bold text-warn">{network.toUpperCase()}</span>;
    return (
        <main className="flex h-full flex-col">
            <header className="site flex items-center gap-2.5 border-b border-dashed border-rule px-4 pt-3.5 pb-3">
                <span className="flex min-w-0 items-center gap-2.5">
                    <span aria-hidden="true" className="pixel grid size-8 shrink-0 place-items-center rounded-[3px] border border-ink text-lg">
                        {site.host[0]?.toUpperCase() ?? '?'}
                    </span>
                    <span className="flex min-w-0 flex-col items-start gap-[3px]">
                        <span className="max-w-full text-base font-bold [overflow-wrap:anywhere]" title={site.origin}>
                            {site.host}
                        </span>
                        {chip ? (
                            <span className="flex items-center gap-1.5 text-xs">
                                <Chip tone={chip.tone}>{chip.text}</Chip>
                                {where}
                            </span>
                        ) : (
                            <span className={cn('text-xs', site.tone === 'plain' ? 'text-ink-2' : text(site.tone))}>
                                {site.note}
                                {where && <> · {where}</>}
                            </span>
                        )}
                    </span>
                </span>
                <span className="flex flex-1 justify-center">{left}</span>
                {picker || (
                    <span className="flex shrink-0 flex-col items-end gap-[3px]">
                        <span className="pixel text-xs text-ink">{account.label}</span>
                        <span className="text-xs text-ink-2" title={account.address}>
                            {short(account.address)}
                        </span>
                    </span>
                )}
            </header>
            {steps}
            <section key={page} className="body scroll flex min-h-0 flex-1 flex-col gap-[18px] px-4 pt-1.5 pb-3.5">
                {children}
            </section>
            <footer className="actions flex gap-2 border-t border-dashed border-rule px-4 pt-3 pb-4">{actions}</footer>
        </main>
    );
}

/** The three steps of a transaction, across the top. With `go`, a step seen already opens with a click: back to it,
 *  or on to it again. */
export function Steps({ at, reached = at, go }: { at: number; reached?: number; go?: (step: number) => void }) {
    return (
        <nav aria-label="Review steps" className="steps px-4 pt-3 pb-2">
            <ol className="flex gap-1">
                {['1 Balances', '2 Programs', '3 Verdict'].map((s, i) => {
                    const step = (
                        <>
                            <span className={cn('block h-[3px]', i <= at ? 'bg-ink' : i <= reached ? 'bg-ink-3' : 'bg-rule-2')} />
                            {s}
                        </>
                    );
                    return (
                        <li key={s} className={cn('pixel flex flex-1 text-xs whitespace-nowrap', i === at ? 'text-ink' : 'text-ink-3')}>
                            {go && i !== at && i <= reached ? (
                                <button type="button" onClick={() => go(i)} className="flex flex-1 cursor-pointer flex-col gap-1.5 text-left hover:text-ink">
                                    {step}
                                </button>
                            ) : (
                                <span className="flex flex-1 flex-col gap-1.5">{step}</span>
                            )}
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}

/** Time left to sign, as a dial that fills as it runs out, turning amber then red near the end; in words on hover. */
export function Left({ from, until, now }: { from: number; until: number; now: number }) {
    const left = Math.max(0, until - now);
    const spent = Math.min(1, Math.max(0, (now - from) / (until - from)));
    const seconds = Math.ceil(left / 1000);
    const words = seconds > 0 ? `You have ${plural(seconds, 'second')} left to sign this before its blockhash expires` : 'Its blockhash expired: it can no longer land';
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span role="timer" aria-label={`${seconds} seconds left to sign`} className={cn('flex shrink-0 cursor-default items-center gap-1 text-xs font-bold tabular-nums', left <= 5_000 ? 'text-danger' : left <= 15_000 ? 'text-warn' : 'text-ink-2')}>
                    <span aria-hidden="true" className="size-[13px] rounded-full border-[1.5px] border-current" style={{ background: `conic-gradient(currentColor ${spent}turn, transparent 0)` }} />
                    {`${seconds}s`}
                </span>
            </TooltipTrigger>
            <TooltipContent sideOffset={6} className="max-w-[220px]">
                {words}
            </TooltipContent>
        </Tooltip>
    );
}

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
    return (
        <span className={cn('chip inline-flex shrink-0 items-center gap-1 rounded-[3px] border border-current px-[7px] py-0.5 text-xs font-bold uppercase', filled(tone))}>
            <Icon name={MARK[tone]} size={11} stroke={3} />
            {children}
        </span>
    );
}

export function Heading({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-2">
            <h2 className="label pixel text-xs text-ink-2">{children}</h2>
            {extra}
        </div>
    );
}

export const Block = ({ children, className }: { children: ReactNode; className?: string }) => (
    <div data-block="" className={cn('flex flex-col gap-1.5', className)}>
        {children}
    </div>
);

export const Notice = ({ children }: { children: ReactNode }) => <p className="notice rounded-[3px] border border-dashed border-rule px-3 py-2.5 text-xs text-ink-2">{children}</p>;

export const WATCH_ONLY = 'Watch-only: Otus holds no key for this account, so it can only show you this review.';

/** An answer: `arms` means it approves or moves on, so it waits while the window is not armed. */
export function Answer({ children, onClick, variant = 'outline', disabled = false, arms = false, armed = true }: { children: ReactNode; onClick: () => void; variant?: 'default' | 'outline' | 'risky' | 'warn'; disabled?: boolean; arms?: boolean; armed?: boolean }) {
    return (
        <Button variant={variant} className="flex-1" disabled={disabled || (arms && !armed)} onClick={onClick} data-arms={arms || undefined}>
            {children}
        </Button>
    );
}

// An address as words name it: cut short, and whole in a tooltip; a click copies it.
import { short } from '@otus-wallet/sdk/format';
import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx';

/** How an address is cut short: four characters a side, or more where it must read apart from one alike. */
export type Cut = (address: string) => string;

/**
 * An address cut short, or by its `name` when Otus knows it by one; whole in a tooltip on hover; a click copies it, and
 * the tooltip says so for a moment, then shows it again. `still`: inside something a click already opens, so only cut
 * short.
 */
export function ShortAddress({ address, name, cut = short, still = false }: { address: string; name?: string; cut?: Cut; still?: boolean }) {
    const [copied, setCopied] = useState(false);
    const trigger = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 500);
        return () => clearTimeout(t);
    }, [copied]);
    const shown = name ?? cut(address);
    if (still) return <span className="whitespace-nowrap">{shown}</span>;
    // Kept open through the click, which a tooltip otherwise closes on (as a press on its trigger, and as one outside it).
    const hold = (e: SyntheticEvent | Event) => e.preventDefault();
    const copy = (e: SyntheticEvent) => {
        hold(e);
        e.stopPropagation();
        void navigator.clipboard.writeText(address).then(() => setCopied(true));
    };
    const key = (e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && copy(e);
    // Gone as the pointer leaves it: addresses sit close, and one's tooltip must not cover the next.
    return (
        <Tooltip disableHoverableContent>
            <TooltipTrigger asChild>
                <span ref={trigger} role="button" tabIndex={0} aria-label={`Copy ${address}`} className="cursor-pointer whitespace-nowrap" onPointerDown={hold} onClick={copy} onKeyDown={key}>
                    {shown}
                </span>
            </TooltipTrigger>
            <TooltipContent sideOffset={6} collisionPadding={8} className="max-w-[340px] text-2xs font-bold text-ink" onPointerDownOutside={(e) => trigger.current?.contains(e.target as Node) && hold(e)}>
                {copied ? 'Copied' : address}
            </TooltipContent>
        </Tooltip>
    );
}

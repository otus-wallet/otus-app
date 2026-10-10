// An address as words name it: cut short, and whole in a tooltip; a click copies it.
import { short } from '@otus-wallet/sdk/format';
import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.tsx';

/** How an address is cut short: four characters a side, or more where it must read apart from one alike. */
export type Cut = (address: string) => string;

/** How the screen cuts its addresses short, knowing which look alike there: four characters a side by default. */
export const AddressCut = createContext<Cut>(short);

/** Your other wallets and contacts on the screen, by your names for them: each tagged where its very address shows. */
export const AddressNames = createContext<ReadonlyMap<string, string>>(new Map());

/** Your name for an address of yours or a contact's, as a grey tag beside it (green is for you). */
export const NameTag = ({ label }: { label: string }) => <span className="ml-1.5 inline-block rounded-[3px] border border-rule bg-panel px-1.5 align-[1px] text-2xs leading-[16px] font-bold text-ink-2">{label}</span>;

/**
 * An address cut short, or by its `name` when Otus knows it by one; whole in a tooltip on hover; a click copies it, and
 * the tooltip says so for a moment, then shows it again. `still`: inside something a click already opens, so only cut
 * short.
 */
export function ShortAddress({ address, name, cut, still = false }: { address: string; name?: string; cut?: Cut; still?: boolean }) {
    const screen = useContext(AddressCut);
    const label = useContext(AddressNames).get(address);
    const [copied, setCopied] = useState(false);
    const trigger = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (!copied) return;
        const t = setTimeout(() => setCopied(false), 500);
        return () => clearTimeout(t);
    }, [copied]);
    const shown = name ?? (cut ?? screen)(address);
    const tag = label && !name && <NameTag label={label} />;
    if (still)
        return (
            <>
                <span className="whitespace-nowrap">{shown}</span>
                {tag}
            </>
        );
    // Kept open through the click, which a tooltip otherwise closes on (as a press on its trigger, and as one outside it).
    const hold = (e: SyntheticEvent | Event) => e.preventDefault();
    const copy = (e: SyntheticEvent) => {
        hold(e);
        e.stopPropagation();
        navigator.clipboard.writeText(address).then(
            () => setCopied(true),
            () => {}, // not copied (the page lost the focus): no "Copied"
        );
    };
    const key = (e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && copy(e);
    // Gone as the pointer leaves it: addresses sit close, and one's tooltip must not cover the next.
    return (
        <>
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
            {tag}
        </>
    );
}

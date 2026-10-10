// Words as Otus writes them, each address in them whole: here cut short, and yours marked with a green "you" tag.
import { createContext, useContext } from 'react';

import { atAddresses, endsYours, YOU } from '@otus-wallet/core/view/names.ts';
import { ShortAddress, type Cut } from './address.tsx';

/** The wallet a screen speaks for: only its own address, right before " (you)", is tagged yours. */
export const YourWallet = createContext<string | null>(null);

/**
 * Words with each address in them cut short (whole on hover, copied on a click), and your wallet's marked: the
 * address, then a "you" tag. " (you)" after anything else (words a program or a token's maker wrote) stays words.
 * `still`: inside something a click already opens, so the addresses are only cut short.
 */
export function Tagged({ text: words, cut, still = false }: { text: string; cut?: Cut; still?: boolean }) {
    const wallet = useContext(YourWallet);
    const parts = words.split(YOU);
    return (
        <>
            {parts.map((part, i) => (
                <span key={i}>
                    {i > 0 && (endsYours(parts[i - 1], wallet) ? <YouTag /> : YOU)}
                    <Addressed text={part} cut={cut} still={still} />
                </span>
            ))}
        </>
    );
}

/** Words with each address in them cut short, and nothing else read in them: for words someone else wrote (a token's
 *  symbol, a validator's name), where " (you)" is only words. */
export const Addressed = ({ text, cut, still = false }: { text: string; cut?: Cut; still?: boolean }) =>
    atAddresses(text).map((w, i) => (i % 2 ? <ShortAddress key={i} address={w} cut={cut} still={still} /> : <Unsplit key={i} text={w} />));

// A short address (its ends, an ellipsis between) on one line: a line may break after an ellipsis, and its two halves
// read apart as two words.
const SHORT = /(\S+…\S+)/;
const Unsplit = ({ text }: { text: string }) => text.split(SHORT).map((w, i) => (i % 2 ? <span key={i} className="whitespace-nowrap">{w}</span> : w));

export const YouTag = () => <span className="ml-1.5 inline-block rounded-[3px] border border-ok-bd bg-ok-bg px-1.5 align-[1px] text-2xs leading-[16px] font-bold text-ok">you</span>;

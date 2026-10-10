// Your address, marked yours: the words give it, then a green "you" tag, wherever Otus names you by address.
import { YOU } from '@otus-wallet/core/view/names.ts';

/** Words with each address of yours marked: the address as the words give it, then a "you" tag. */
export function Tagged({ text: words }: { text: string }) {
    return (
        <>
            {words.split(YOU).map((part, i) => (
                <span key={i}>
                    {i > 0 && <YouTag />}
                    <Unsplit text={part} />
                </span>
            ))}
        </>
    );
}

// A short address (its ends, an ellipsis between) on one line: a line may break after an ellipsis, and its two halves
// read apart as two words.
const SHORT = /(\S+…\S+)/;
const Unsplit = ({ text }: { text: string }) => text.split(SHORT).map((w, i) => (i % 2 ? <span key={i} className="whitespace-nowrap">{w}</span> : w));

export const YouTag = () => <span className="ml-1.5 inline-block rounded-[3px] border border-ok-bd bg-ok-bg px-1.5 align-[1px] text-2xs leading-[16px] font-bold text-ok">you</span>;

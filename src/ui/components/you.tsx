// Your address, marked yours: the words give it, then a green "you" tag, wherever Otus names you by address.
import { YOU } from '../view/names.ts';

/** Words with each address of yours marked: the address as the words give it, then a "you" tag. */
export function Tagged({ text: words }: { text: string }) {
    return (
        <>
            {words.split(YOU).map((part, i) => (
                <span key={i}>
                    {i > 0 && <YouTag />}
                    {part}
                </span>
            ))}
        </>
    );
}

export const YouTag = () => <span className="ml-1.5 inline-block rounded-[3px] border border-ok-bd bg-ok-bg px-1.5 align-[1px] text-[10px] leading-[16px] font-bold text-ok">you</span>;

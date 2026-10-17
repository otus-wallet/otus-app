// The terms of use, over the wallet until accepted: once, or again when they change in a way that matters.
import type { ReactNode } from 'react';

import { save } from '@otus-wallet/core/state.ts';
import { accepting, TERMS_URL } from '@otus-wallet/core/terms.ts';
import { Button } from '../components/ui/button.tsx';

const Point = ({ lead, children }: { lead: string; children: ReactNode }) => (
    <li className="text-xs leading-[1.6] text-ink-2">
        <strong className="text-ink">{lead}</strong> {children}
    </li>
);

export function Terms() {
    return (
        <div role="dialog" aria-modal="true" aria-labelledby="terms-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
            <div className="scroll flex max-h-full flex-col gap-3.5 rounded-[3px] border border-rule bg-panel p-4">
                <h1 id="terms-title" className="pixel text-sm">
                    Terms of use
                </h1>
                <ul className="flex flex-col gap-2.5">
                    <Point lead="Your keys stay with you.">
                        Otus is self-custodial: your recovery phrase and keys never leave this device. No one, Otus included, can reach your funds or recover them if you lose your phrase.
                    </Point>
                    <Point lead="Otus shows what it can read.">
                        It decodes every transaction it can and shows how your wallet and accounts end up before you sign. Like any software it can have bugs, and some programs can&apos;t be read: Otus can&apos;t guarantee that what it shows is complete or
                        correct.
                    </Point>
                    <Point lead="You decide what you sign.">Solana transactions are final: once one lands, it can&apos;t be undone.</Point>
                    <Point lead="Provided as is.">Otus is free, open-source software with no warranty. Otus isn&apos;t liable for losses from what you sign, from bugs, or from third parties: sites, tokens, programs, the network.</Point>
                </ul>
                <Button variant="default" className="w-full" onClick={() => void save({ terms: accepting() })}>
                    Accept
                </Button>
                <a href={TERMS_URL} target="_blank" rel="noreferrer" className="self-center text-xs text-ink-3 hover:text-ink">
                    Read the full terms
                </a>
            </div>
        </div>
    );
}

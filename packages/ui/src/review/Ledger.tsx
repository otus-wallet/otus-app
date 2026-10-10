// Signing on the Ledger, once approved: the window finds the Ledger that holds the account, sends it the very message
// the background gave, and waits while the user confirms there. The signature goes to the background, which takes it
// only if it checks out. What the device cannot read in clear it shows as this message hash, the one shown here.
import { getBase64Decoder, getBase64Encoder, type Address } from '@solana/kit';
import { useEffect } from 'react';

import { onLedgerOf } from '@otus-wallet/core/ledger/devices.ts';
import { sign } from '@otus-wallet/core/ledger/solana.ts';
import { pairInTab, useLedger } from '../ledger.ts';
import type { TransactionView } from '@otus-wallet/core/view.ts';
import type { Expiry } from './Approve.tsx';
import { Answer, Block, Frame, Heading, Left, Notice, useNow } from './Frame.tsx';

/** `expiry`: the time left to sign, still counting here; `died`: the network says the blockhash can no longer land,
 *  and Otus stops waiting for the device. */
export function OnLedger({ t, answer, expiry, died = false }: { t: TransactionView & { ledger: NonNullable<TransactionView['ledger']> }; answer: (yes: boolean, signature?: string) => void; expiry?: Expiry; died?: boolean }) {
    const { state, start, stop } = useLedger(
        (signal, confirming) =>
            onLedgerOf(
                { address: t.account.address as Address, path: t.ledger.path },
                (exchange) => {
                    confirming();
                    return sign(exchange, t.ledger.path, new Uint8Array(getBase64Encoder().encode(t.ledger.message)));
                },
                signal,
            ),
        (signature) => answer(true, getBase64Decoder().decode(signature)),
    );
    useEffect(start, [start]);
    const now = useNow(expiry ? 250 : null);
    const expired = died;
    useEffect(() => void (expired && stop()), [expired, stop]);
    const failed = state.phase === 'failed' ? state.error : null;
    const again = expired ? expiry?.refresh : failed ? start : undefined;
    return (
        <Frame
            site={t.site}
            account={t.account}
            network={t.network}
            chip={t.chip}
            left={expiry && <Left from={expiry.from} until={expiry.until} now={now} />}
            actions={
                <>
                    <Answer onClick={() => answer(false)}>Reject</Answer>
                    {again && (
                        <Answer variant="default" onClick={again}>
                            {expired ? 'Build it again' : 'Try again'}
                        </Answer>
                    )}
                </>
            }
        >
            {expired && (
                <Notice>
                    Its <span className="font-bold text-warn">blockhash expired</span> before your Ledger signed it, so nothing was sent. {expiry?.refresh ? 'Building it again takes a fresh one.' : 'Ask the site for it again.'}
                </Notice>
            )}
            <Block>
                <Heading>Sign on your Ledger</Heading>
                {expired ? null : failed ? (
                    <p role="alert" className="text-xs text-danger">
                        {failed.message}
                    </p>
                ) : (
                    <p className="text-xs text-ink-2">{state.phase === 'confirming' ? 'Check it on your Ledger, then confirm it there.' : 'Connect your Ledger, unlock it and open its Solana app.'}</p>
                )}
                {failed?.trouble === 'unplugged' && (
                    <button type="button" className="cursor-pointer self-start text-xs text-ink-2 underline" onClick={pairInTab}>
                        Not found? Connect it again in a tab
                    </button>
                )}
            </Block>
            <Block>
                <Heading>Message hash</Heading>
                <p className="hash text-lg leading-[1.7] font-bold [word-spacing:0.3em]">{t.hash}</p>
                <p className="text-xs text-ink-3">When your Ledger cannot show what it signs, it shows this hash: it must be the same.</p>
            </Block>
            {t.recipient && <Notice>{`When it can, your Ledger shows the amount and where it goes: ${t.recipient}`}</Notice>}
        </Frame>
    );
}

// Receiving: the address as a QR code with the wallet's own tile in its middle, written out whole, its ends marked, and
// to copy. A Ledger account's can be checked on the device's own screen, the one Otus cannot draw on.
import type { Address } from '@solana/kit';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { onLedgerOf } from '@otus-wallet/core/ledger/devices.ts';
import { LedgerError } from '@otus-wallet/core/ledger/hid.ts';
import { address as addressAt } from '@otus-wallet/core/ledger/solana.ts';
import type { Account, State } from '@otus-wallet/core/state.ts';
import { Button } from '../components/ui/button.tsx';
import { pairInTab, useLedger } from '../ledger.ts';
import type { Screen } from './App.tsx';
import { Bar, CopyButton, ErrorLine, Sheet } from './common.tsx';
import { qr } from './qr.ts';
import { current } from './store.ts';

export function Receive({ state, go }: { state: State; go: (to: Screen) => void }) {
    const account = current(state);
    const { address } = account;
    const code = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => void code.current?.replaceChildren(qr(address)), [address]);
    return (
        <Sheet bar={<Bar title="Receive" back={() => go('lobby')} />} className="items-center text-center">
            <div ref={code} className="qr mt-2.5 overflow-hidden rounded-[3px] leading-[0]" />
            <p className="whole max-w-[320px] text-sm leading-relaxed font-bold break-all text-ink-2">
                <span className="text-ok">{address.slice(0, 4)}</span>
                {address.slice(4, -4)}
                <span className="text-ok">{address.slice(-4)}</span>
            </p>
            <CopyButton text={() => address} label="Copy address" />
            {account.ledger && <OnLedger key={address} account={account as Account & { ledger: { path: string } }} />}
        </Sheet>
    );
}

// The address shown on the Ledger, for the user to compare with this one and confirm there. Read quietly first from a
// Ledger plugged in: an address changed in storage (as malware may, while Chrome is closed) is not the device's.
function OnLedger({ account }: { account: Account & { ledger: { path: string } } }) {
    const [checked, setChecked] = useState(false);
    const [other, setOther] = useState(false);
    const { path } = account.ledger;
    useEffect(() => {
        const stop = new AbortController();
        onLedgerOf({ address: account.address as Address, path }, async () => true, stop.signal).catch((e: unknown) => setOther(e instanceof LedgerError && e.trouble === 'stranger'));
        return () => stop.abort();
    }, [account.address, path]);
    const { state, start } = useLedger(
        (signal, confirming) =>
            onLedgerOf(
                { address: account.address as Address, path },
                (exchange) => {
                    confirming();
                    return addressAt(exchange, path, true);
                },
                signal,
            ),
        (shown) => setChecked(shown === account.address),
    );
    if (checked) return <p className="text-xs text-ok">You confirmed it on your Ledger.</p>;
    const warning = other && <p className="text-xs font-bold text-danger">The Ledger plugged in gives another address for this account. Don't share this one until you check it there.</p>;
    if (state.phase === 'confirming') return <p className="text-xs text-ink-2">Your Ledger shows its address: check it is this one, then confirm there.</p>;
    return (
        <div className="flex flex-col items-center gap-1.5">
            {warning}
            <Button size="sm" disabled={state.phase === 'looking'} onClick={start}>
                Check it on your Ledger
            </Button>
            {state.phase === 'failed' && <ErrorLine>{state.error.message}</ErrorLine>}
            {state.phase === 'failed' && state.error.trouble === 'unplugged' && (
                <button type="button" className="cursor-pointer text-xs text-ink-2 underline" onClick={pairInTab}>
                    Not found? Connect it again in a tab
                </button>
            )}
        </div>
    );
}

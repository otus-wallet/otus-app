// A Ledger operation as a page runs it: one try at a time (each waits for the one before to let the device go), stopped
// when the page goes, and tried again once a Ledger is plugged in after it failed for want of one (opening the Solana
// app plugs the device in again). The Ledger in use going mid-way ends it: devices.ts says so.
import { useCallback, useEffect, useRef, useState } from 'react';

import { onPlug } from '../ledger/devices.ts';
import { platform } from '../platform.ts';
import { LedgerError, type Trouble } from '../ledger/hid.ts';

/** `looking`: finding the Ledger that holds the account; `confirming`: it asks the user, on its screen. */
export type LedgerState = { phase: 'idle' | 'looking' | 'confirming' } | { phase: 'failed'; error: LedgerError };

// What a Ledger plugged in, or into its Solana app, may change.
const WANTING: Trouble[] = ['unplugged', 'closed', 'locked', 'busy', 'stranger', 'silent'];

/** `work` gets the signal that stops it and a call to make once the device asks the user; `done` hears what it gave. */
export function useLedger<T>(work: (signal: AbortSignal, confirming: () => void) => Promise<T>, done: (value: T) => void) {
    const [state, setState] = useState<LedgerState>({ phase: 'idle' });
    const running = useRef<AbortController | null>(null);
    const settled = useRef<Promise<unknown>>(Promise.resolve()); // the last try, over
    const job = useRef({ work, done });
    job.current = { work, done };

    const start = useCallback(() => {
        running.current?.abort();
        const stop = new AbortController();
        running.current = stop;
        setState({ phase: 'looking' });
        const run = settled.current.then(() => job.current.work(stop.signal, () => void (running.current === stop && setState({ phase: 'confirming' }))));
        settled.current = run.catch(() => {});
        run.then(
            (value) => {
                if (running.current !== stop) return;
                running.current = null;
                setState({ phase: 'idle' });
                job.current.done(value);
            },
            (e: unknown) => {
                if (running.current !== stop) return; // stopped for another try, or the page went
                running.current = null;
                setState({ phase: 'failed', error: e instanceof LedgerError ? e : new LedgerError('refused', 'Otus could not reach your Ledger') });
            },
        );
    }, []);

    /** Stops waiting, as when the time to sign is out. */
    const stop = useCallback(() => {
        running.current?.abort();
        running.current = null;
        setState({ phase: 'idle' });
    }, []);

    useEffect(() => () => void running.current?.abort(), []);
    useEffect(() => onPlug((plugged) => plugged && state.phase === 'failed' && WANTING.includes(state.error.trouble) && start()), [state, start]);
    return { state, start, stop };
}

/** The setup tab, where Chrome lets Otus be granted a Ledger. */
export const pairInTab = () => void platform.openTab('welcome.html#ledger');

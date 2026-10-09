// The Ledgers Otus can reach through WebHID. Chrome grants each device to Otus's origin once, from its chooser, which it
// shows only in a tab (the setup tab); after that, every Otus page reaches it without asking. A Ledger shows up again
// as another device when it moves between its dashboard and an app, so it is paired with the Solana app open.
import type { Address } from '@solana/kit';

import { LEDGER_VENDOR_ID, LedgerError, stopped, talk, type Device, type Exchange } from './hid.ts';
import { address, solanaApp, type Configuration } from './solana.ts';

const APDU_USAGE_PAGE = 0xffa0; // the interface that takes APDUs; a Ledger may show others, as FIDO's

/** A WebHID device, as much of it as Otus uses. */
export type HidDevice = Device & { readonly vendorId: number; readonly productName: string; readonly collections: readonly { usagePage?: number }[] };

/** navigator.hid, as much of it as Otus uses. Tests pass a fake. */
export type Hid = {
    getDevices(): Promise<HidDevice[]>;
    requestDevice(options: { filters: { vendorId: number }[] }): Promise<HidDevice[]>;
    addEventListener(type: 'connect' | 'disconnect', listener: (event: { device: HidDevice }) => void): void;
    removeEventListener(type: 'connect' | 'disconnect', listener: (event: { device: HidDevice }) => void): void;
};

const browserHid = (): Hid | undefined => (globalThis.navigator as unknown as { hid?: Hid } | undefined)?.hid;

const isLedger = (d: HidDevice) => d.vendorId === LEDGER_VENDOR_ID && (d.collections.length === 0 || d.collections.some((c) => c.usagePage === APDU_USAGE_PAGE));

/** The Ledgers Otus may talk to that are plugged in now. */
export async function ledgers(hid = browserHid()): Promise<HidDevice[]> {
    return hid ? (await hid.getDevices()).filter(isLedger) : [];
}

/** Chrome's chooser, for the user to grant Otus a Ledger: only from a click, in a tab. Null when they chose none. */
export async function pair(hid = browserHid()): Promise<HidDevice | null> {
    if (!hid) throw new LedgerError('unplugged', 'This browser cannot reach a Ledger');
    return (await hid.requestDevice({ filters: [{ vendorId: LEDGER_VENDOR_ID }] })).find(isLedger) ?? null;
}

/** Calls back when a Ledger is plugged in or goes, as when it opens or leaves an app. Returns the way to stop. */
export function onPlug(listener: (plugged: boolean) => void, hid = browserHid()): () => void {
    if (!hid) return () => {};
    const plugged = ({ device }: { device: HidDevice }) => isLedger(device) && listener(true);
    const gone = ({ device }: { device: HidDevice }) => isLedger(device) && listener(false);
    hid.addEventListener('connect', plugged);
    hid.addEventListener('disconnect', gone);
    return () => {
        hid.removeEventListener('connect', plugged);
        hid.removeEventListener('disconnect', gone);
    };
}

/** A conversation with this Ledger (hid.ts's talk), ended `unplugged` when it goes mid-way: only this one. */
export async function talkTo<T>(device: HidDevice, work: (exchange: Exchange) => Promise<T>, signal?: AbortSignal, hid = browserHid()): Promise<T> {
    const gone = new AbortController();
    const unplugged = (e: { device: HidDevice }) => e.device === device && gone.abort(new LedgerError('unplugged', 'Your Ledger was disconnected'));
    hid?.addEventListener('disconnect', unplugged);
    try {
        return await talk(device, work, signal ? AbortSignal.any([signal, gone.signal]) : gone.signal);
    } finally {
        hid?.removeEventListener('disconnect', unplugged);
    }
}

/** A Ledger account: its address, and the path of its key. */
export type LedgerKey = { address: Address; path: string };

/** `work` on the Ledger that holds this account, once its Solana app is open and the key at the path is that account's.
 *  Each Ledger plugged in is asked in turn. Throws LedgerError: when none holds it, the most telling trouble met (the
 *  Solana app closed, the device locked or busy), else `stranger`; `unplugged` when no Ledger is there. */
export async function onLedgerOf<T>(key: LedgerKey, work: (exchange: Exchange, app: Configuration) => Promise<T>, signal?: AbortSignal, hid = browserHid()): Promise<T> {
    const met: LedgerError[] = [];
    for (const device of await ledgers(hid)) {
        if (signal?.aborted) throw stopped(signal.reason);
        try {
            const done = await talkTo(
                device,
                async (exchange) => {
                    const app = await solanaApp(exchange);
                    if ((await address(exchange, key.path)) !== key.address) return { mine: false } as const;
                    return { mine: true, value: await work(exchange, app) } as const;
                },
                signal,
                hid,
            );
            if (done.mine) return done.value;
        } catch (e) {
            if (!(e instanceof LedgerError) || !(TELLING as readonly string[]).includes(e.trouble)) throw e;
            met.push(e);
        }
    }
    const telling = TELLING.map((t) => met.find((e) => e.trouble === t)).find(Boolean);
    if (telling) throw telling;
    throw (await ledgers(hid)).length ? new LedgerError('stranger', 'This Ledger does not hold this account') : new LedgerError('unplugged', 'Connect your Ledger and open the Solana app');
}

// What one device's failure says about it alone, in the order worth telling: another Ledger may still hold the account.
const TELLING = ['locked', 'closed', 'busy', 'unplugged', 'garbled', 'silent'] as const satisfies LedgerError['trouble'][];

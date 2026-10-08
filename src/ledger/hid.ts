// Ledger's USB HID transport. An APDU goes out in 64-byte reports, each headed by a channel, the tag 0x05 and its
// sequence number; the first also carries the APDU's length. The answer comes back framed the same way, its last two
// bytes the status word. The device is opened for one conversation at a time across all of Otus's pages, and closed
// after it, so nothing stays connected and other apps can reach it.

export const LEDGER_VENDOR_ID = 0x2c97;

const REPORT = 64;
const HEADER = 5; // channel (2), tag (1), sequence (2)
const TAG = 0x05;
const CHANNEL = 0x0101;
const MAX_ANSWER = 1024; // bytes; the Solana app answers with 64 at most, plus the status word
const LOCK = 'otus:ledger';

type Listener = (event: { data: DataView }) => void;

/** The part of a WebHID device the transport uses. Tests pass a fake. */
export type Device = {
    readonly opened: boolean;
    open(): Promise<void>;
    close(): Promise<void>;
    sendReport(reportId: number, data: Uint8Array<ArrayBuffer>): Promise<void>;
    addEventListener(type: 'inputreport', listener: Listener): void;
    removeEventListener(type: 'inputreport', listener: Listener): void;
};

/** Why talking to the Ledger failed, for a page to say in words. The transport's: `busy` another app or Otus window
 *  has it, `unplugged` it went away, `garbled` its answer made no sense, `silent` it did not answer in time,
 *  `cancelled` Otus stopped waiting. The Solana app's (solana.ts): `locked`, `closed` (the Solana app is not open),
 *  `blind` (blind signing is off), `rejected` (by the user, on the device), `stranger` (the key is not this
 *  account's), `refused` (anything else it said no to). */
export type Trouble = 'busy' | 'unplugged' | 'garbled' | 'silent' | 'cancelled' | 'locked' | 'closed' | 'blind' | 'rejected' | 'stranger' | 'refused';

export class LedgerError extends Error {
    readonly trouble: Trouble;
    constructor(trouble: Trouble, message: string) {
        super(message);
        this.trouble = trouble;
    }
}

export const garbled = () => new LedgerError('garbled', 'Your Ledger answered something Otus cannot read');

/** An APDU → the reports that carry it, zero padded. */
export function frames(apdu: Uint8Array, channel = CHANNEL): Uint8Array<ArrayBuffer>[] {
    const payload = new Uint8Array(2 + apdu.length);
    new DataView(payload.buffer).setUint16(0, apdu.length);
    payload.set(apdu, 2);
    const reports: Uint8Array<ArrayBuffer>[] = [];
    for (let at = 0, sequence = 0; at < payload.length; at += REPORT - HEADER, sequence++) {
        const report = new Uint8Array(REPORT);
        const view = new DataView(report.buffer);
        view.setUint16(0, channel);
        report[2] = TAG;
        view.setUint16(3, sequence);
        report.set(payload.subarray(at, at + REPORT - HEADER), HEADER);
        reports.push(report);
    }
    return reports;
}

/** A reader for one answer: each report in turn → the whole answer once it is complete, else null. Reports on another
 *  channel are not this conversation's and are skipped; one out of order throws. */
export function reader(channel = CHANNEL): (report: Uint8Array) => Uint8Array | null {
    let sequence = 0;
    let length = 0;
    const answer: number[] = [];
    return (report) => {
        if (report.length < HEADER + 2) throw garbled();
        const view = new DataView(report.buffer, report.byteOffset, report.byteLength);
        if (view.getUint16(0) !== channel) return null;
        if (report[2] !== TAG || view.getUint16(3) !== sequence) throw garbled();
        let data = report.subarray(HEADER);
        if (sequence === 0) {
            length = view.getUint16(HEADER);
            if (length < 2 || length > MAX_ANSWER) throw garbled(); // at least the status word
            data = data.subarray(2);
        }
        sequence++;
        answer.push(...data.subarray(0, length - answer.length));
        return answer.length === length ? Uint8Array.from(answer) : null;
    };
}

/** Sends APDUs on an open device: each one → its answer, status word included. `wait`: ms to wait for one that asks
 *  nothing of the user, which then ends `silent`; none for one the user answers on the device. */
export type Exchange = (apdu: Uint8Array, wait?: number) => Promise<Uint8Array>;

/** A conversation with the Ledger: `work` gets the device to itself, opened for it and closed after, whatever happens.
 *  One at a time across Otus's pages: while another is going on, `busy` at once rather than a wait the user cannot see.
 *  `signal` ends any wait for an answer; a TimeoutError reason reads as `silent`, a LedgerError as itself. */
export async function talk<T>(device: Device, work: (exchange: Exchange) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw stopped(signal.reason); // not even the lock, which another try may be about to take
    const run = async () => {
        if (signal?.aborted) throw stopped(signal.reason);
        try {
            if (!device.opened) await device.open();
        } catch {
            throw new LedgerError('busy', 'Another app is using your Ledger: close it and try again');
        }
        try {
            return await work((apdu, wait) => exchange(device, apdu, wait === undefined ? signal : AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(wait)])));
        } finally {
            await device.close().catch(() => {});
        }
    };
    const locks = globalThis.navigator?.locks;
    if (!locks) return run();
    return locks.request(LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) throw new LedgerError('busy', 'Your Ledger is in use in another Otus window');
        return run();
    });
}

// One APDU and its answer. The listener is in place before the first report goes, so no answer is missed.
async function exchange(device: Device, apdu: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    const read = reader();
    let listener: Listener = () => {};
    let quit = () => {};
    const answered = new Promise<Uint8Array>((resolve, reject) => {
        listener = ({ data }) => {
            try {
                const answer = read(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
                if (answer) resolve(answer);
            } catch (e) {
                reject(e);
            }
        };
        quit = () => reject(stopped(signal?.reason));
    });
    answered.catch(() => {}); // a send that fails ends the exchange first
    const ended = answered.then(() => {}); // or the signal, while a send hangs
    ended.catch(() => {});
    if (signal?.aborted) throw stopped(signal.reason);
    signal?.addEventListener('abort', quit, { once: true });
    device.addEventListener('inputreport', listener);
    try {
        for (const report of frames(apdu)) {
            const sent = device.sendReport(0, report).catch(() => {
                throw new LedgerError('unplugged', 'Your Ledger is not connected');
            });
            sent.catch(() => {}); // failing after the signal ended it, it has no one to tell
            await Promise.race([sent, ended]);
        }
        return await answered;
    } finally {
        device.removeEventListener('inputreport', listener);
        signal?.removeEventListener('abort', quit);
    }
}

/** Why a wait was stopped, as a LedgerError. */
export function stopped(reason: unknown): LedgerError {
    if (reason instanceof LedgerError) return reason;
    if (reason instanceof DOMException && reason.name === 'TimeoutError') return new LedgerError('silent', 'Your Ledger did not answer');
    return new LedgerError('cancelled', 'Otus stopped waiting for your Ledger');
}

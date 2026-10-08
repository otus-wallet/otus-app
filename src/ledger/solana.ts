// The Ledger's Solana app, as Otus speaks to it over an Exchange (hid.ts): which app is open, its settings, the
// address at a path, and a signature of a transaction message. What the device says no to becomes a LedgerError
// whose trouble a page can put in words.
import { getAddressDecoder, type Address, type SignatureBytes } from '@solana/kit';

import { garbled, LedgerError, type Exchange, type Trouble } from './hid.ts';

const CLA = 0xe0;
const INS = { configuration: 0x04, address: 0x05, sign: 0x06 };
const P1_CONFIRM = 0x01;
const P2_EXTEND = 0x01; // this chunk continues the one before
const P2_MORE = 0x02; // another chunk follows
const CHUNK = 255; // bytes of data in one APDU
const OK = 0x9000;
const HARDENED = 0x80000000;
const QUIET = 5_000; // ms for an answer that asks nothing of the user

/** The Solana app's settings: whether blind signing is on, and its version. */
export type Configuration = { blindSigning: boolean; version: string };

// What the device's status words mean. The app answers some of them for what it cannot show or sign; the device's
// own system answers the rest, as when it is locked or another app (or none) is open.
const STATUS: Record<number, [Trouble, string]> = {
    0x6985: ['rejected', 'You rejected it on your Ledger'],
    0x6808: ['blind', "Turn on blind signing in the Solana app's settings on your Ledger, then try again"],
    0x5515: ['locked', 'Unlock your Ledger'],
    0x6b0c: ['locked', 'Unlock your Ledger'],
    0x6e00: ['closed', 'Open the Solana app on your Ledger'],
    0x6e01: ['closed', 'Open the Solana app on your Ledger'],
    0x6d00: ['closed', 'Open the Solana app on your Ledger'],
    0x6d02: ['closed', 'Open the Solana app on your Ledger'],
    0x6511: ['closed', 'Open the Solana app on your Ledger'],
};

/** A derivation path as wallets write it, "44'/501'/0'/0'" (an "m/" before it allowed) → the bytes the app takes: the
 *  number of levels, then each one, big-endian. Solana keys are all hardened, under 44'/501', two to five levels.
 *  Throws for anything else. */
export function pathBytes(path: string): Uint8Array {
    const levels = path.replace(/^m\//, '').split('/');
    if (levels.length < 2 || levels.length > 5 || !levels.every((l) => /^\d{1,10}'$/.test(l))) throw new Error(`not a Solana derivation path: ${path}`);
    const indexes = levels.map((l) => Number(l.slice(0, -1)));
    if (indexes[0] !== 44 || indexes[1] !== 501 || indexes.some((i) => i >= HARDENED)) throw new Error(`not a Solana derivation path: ${path}`);
    const out = new Uint8Array(1 + 4 * indexes.length);
    out[0] = indexes.length;
    indexes.forEach((i, n) => new DataView(out.buffer).setUint32(1 + 4 * n, (i + HARDENED) >>> 0));
    return out;
}

/** Checks that the Solana app is open and reads its settings. */
export async function solanaApp(exchange: Exchange): Promise<Configuration> {
    // The device's own question (CLA 0xB0): which app is open. "BOLOS" is the dashboard.
    const app = await call(exchange, [0xb0, 0x01, 0, 0], new Uint8Array(), { wait: QUIET });
    const name = app[0] === 1 && app.length > 2 ? new TextDecoder().decode(app.subarray(2, 2 + app[1])) : '';
    if (name !== 'Solana') throw new LedgerError('closed', 'Open the Solana app on your Ledger');
    const c = await call(exchange, [CLA, INS.configuration, 0, 0], new Uint8Array(), { wait: QUIET });
    if (c.length < 5) throw garbled();
    return { blindSigning: c[0] === 1, version: `${c[2]}.${c[3]}.${c[4]}` };
}

/** The address of the key at this path. `show`: the device shows it too, and the user confirms it there. */
export async function address(exchange: Exchange, path: string, show = false): Promise<Address> {
    const key = await call(exchange, [CLA, INS.address, show ? P1_CONFIRM : 0, 0], pathBytes(path), { wait: show ? undefined : QUIET });
    if (key.length !== 32) throw garbled();
    return getAddressDecoder().decode(key);
}

/** The key at this path signs a transaction message (legacy or v0), once the user confirms it on the device: shown
 *  in clear when the app can read all of it, otherwise as its hash, with blind signing on. The app cannot read v1
 *  messages: they are never sent to it. */
export async function sign(exchange: Exchange, path: string, message: Uint8Array): Promise<SignatureBytes> {
    if (message[0] >= 0x80 && message[0] !== 0x80) throw new LedgerError('refused', 'Ledger cannot sign version 1 transactions');
    const data = Uint8Array.from([1, ...pathBytes(path), ...message]); // one signer: this path
    let p2 = 0;
    for (let at = 0; ; at += CHUNK) {
        const more = data.length - at > CHUNK;
        const answer = await call(exchange, [CLA, INS.sign, P1_CONFIRM, p2 | (more ? P2_MORE : 0)], data.subarray(at, at + CHUNK), { meanings: { 0x6a81: ['stranger', 'This Ledger does not hold this account'] } });
        if (more) {
            if (answer.length !== 0) throw garbled();
            p2 = P2_EXTEND;
            continue;
        }
        if (answer.length !== 64) throw garbled();
        return answer as SignatureBytes;
    }
}

// One APDU (its CLA, INS, P1 and P2, then its data) → its answer's data, once the status word says it went well;
// otherwise the LedgerError it means. `meanings`: what this command's own status words mean; `wait`: as Exchange's.
async function call(exchange: Exchange, head: [number, number, number, number], data: Uint8Array, o: { meanings?: Record<number, [Trouble, string]>; wait?: number } = {}): Promise<Uint8Array> {
    const answer = await exchange(Uint8Array.from([...head, data.length, ...data]), o.wait);
    const status = (answer[answer.length - 2] << 8) | answer[answer.length - 1];
    if (status === OK) return answer.subarray(0, -2);
    const [trouble, words] = o.meanings?.[status] ?? STATUS[status] ?? ['refused', `Your Ledger refused it (${status.toString(16).padStart(4, '0')})`];
    throw new LedgerError(trouble, words);
}

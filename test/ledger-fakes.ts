import assert from 'node:assert/strict';

import { generateKeyPair, getAddressEncoder, getAddressFromPublicKey, signBytes } from '@solana/kit';

import type { HidDevice } from '../src/ledger/devices.ts';
import { frames, LedgerError, reader, type Exchange } from '../src/ledger/hid.ts';
import { pathBytes } from '../src/ledger/solana.ts';

export const PATH = "44'/501'/0'/0'";
export const OK = [0x90, 0x00];
export const sw = (code: number) => Uint8Array.of(code >> 8, code & 0xff);
export const trouble = (t: string) => (e: unknown) => e instanceof LedgerError && e.trouble === t;

/** The Solana app as the device runs it: the key at PATH signs, chunks are put together by their P2 flags, and
 *  `blindOnly` messages need blind signing on. It logs each APDU's INS, P1 and P2. */
export async function fakeApp(o: { app?: string; blind?: boolean; status?: number; reject?: boolean; blindOnly?: boolean } = {}) {
    const keys = await generateKeyPair();
    const owner = await getAddressFromPublicKey(keys.publicKey);
    const log: string[] = [];
    let gathered: number[] = [];
    const exchange: Exchange = async (apdu) => {
        const [cla, ins, p1, p2, lc] = apdu;
        const data = apdu.subarray(5);
        assert.equal(lc, data.length);
        assert.ok(data.length <= 255);
        log.push(`${cla.toString(16)} ${ins.toString(16)} ${p1} ${p2}`);
        if (o.status) return sw(o.status);
        if (cla === 0xb0 && ins === 0x01) {
            const name = new TextEncoder().encode(o.app ?? 'Solana');
            return Uint8Array.from([1, name.length, ...name, 6, ...new TextEncoder().encode('1.17.1'), 1, 0, ...OK]);
        }
        if (ins === 0x04) return Uint8Array.from([o.blind ? 1 : 0, 0, 1, 17, 1, ...OK]);
        const path = [...pathBytes(PATH)];
        if (ins === 0x05) {
            if (p1 === 1 && o.reject) return sw(0x6985);
            const at = data.length === path.length && data.every((b, i) => b === path[i]);
            return Uint8Array.from([...(at ? getAddressEncoder().encode(owner) : new Uint8Array(32).fill(1)), ...OK]);
        }
        if (ins === 0x06) {
            gathered = p2 & 0x01 ? [...gathered, ...data] : [...data];
            if (p2 & 0x02) return Uint8Array.from(OK);
            assert.equal(gathered[0], 1, 'one signer');
            assert.deepEqual(gathered.slice(1, 1 + path.length), path);
            if (o.reject) return sw(0x6985);
            if (o.blindOnly && !o.blind) return sw(0x6808);
            const signature = await signBytes(keys.privateKey, Uint8Array.from(gathered.slice(1 + path.length)));
            return Uint8Array.from([...signature, ...OK]);
        }
        return sw(0x6d00);
    };
    return { exchange, owner, log };
}


/** A WebHID device that carries APDUs to `exchange`, framed as a Ledger frames them. */
export function hidDevice(exchange: Exchange, o: { productName?: string; vendorId?: number; usagePages?: number[] } = {}): HidDevice {
    const listeners = new Set<(e: { data: DataView }) => void>();
    let read = reader();
    let opened = false;
    return {
        vendorId: o.vendorId ?? 0x2c97,
        productName: o.productName ?? 'Flex',
        collections: (o.usagePages ?? [0xffa0]).map((usagePage) => ({ usagePage })),
        get opened() {
            return opened;
        },
        open: async () => void (opened = true),
        close: async () => void (opened = false),
        async sendReport(_, report) {
            const apdu = read(report);
            if (!apdu) return;
            read = reader();
            // Sent at once; the answer comes when the device has one, as a real Ledger's does.
            void exchange(apdu).then((answer) => {
                for (const r of frames(answer)) setTimeout(() => listeners.forEach((l) => l({ data: new DataView(r.buffer) })));
            });
        },
        addEventListener: (_, l) => void listeners.add(l),
        removeEventListener: (_, l) => void listeners.delete(l),
    };
}

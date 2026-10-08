import assert from 'node:assert/strict';
import { test } from 'node:test';

import { frames, LedgerError, reader, talk, type Device } from '../src/ledger/hid.ts';

const bytes = (n: number, from = 0) => Uint8Array.from({ length: n }, (_, i) => (from + i) % 256);
const OK = [0x90, 0x00];

type Fake = Device & { log: string[]; listeners: number };

/** A Ledger that answers each whole APDU it reads with `answer` (status word included), one report at a time; null
 *  leaves it silent. It logs opening, closing and each APDU it read. */
function fakeLedger(answer: (apdu: Uint8Array) => Uint8Array | null, fails: { open?: boolean; send?: boolean } = {}): Fake {
    const listeners = new Set<(e: { data: DataView }) => void>();
    let read = reader();
    let opened = false;
    const fake: Fake = {
        get opened() {
            return opened;
        },
        log: [],
        get listeners() {
            return listeners.size;
        },
        async open() {
            if (fails.open) throw new Error('NotAllowedError');
            fake.log.push('open');
            opened = true;
        },
        async close() {
            fake.log.push('close');
            opened = false;
        },
        async sendReport(id, report) {
            assert.equal(id, 0);
            assert.equal(report.length, 64);
            if (fails.send) throw new Error('NetworkError');
            const apdu = read(report);
            if (!apdu) return;
            read = reader();
            fake.log.push(`apdu ${apdu.length}`);
            const reply = answer(apdu);
            if (!reply) return;
            for (const r of frames(reply)) setTimeout(() => listeners.forEach((l) => l({ data: new DataView(r.buffer) })));
        },
        addEventListener: (_, l) => void listeners.add(l),
        removeEventListener: (_, l) => void listeners.delete(l),
    };
    return fake;
}

const trouble = (t: string) => (e: unknown) => e instanceof LedgerError && e.trouble === t;

test('an APDU that fits one report: channel, tag, sequence 0, its length, then zeros', () => {
    const [report, ...more] = frames(Uint8Array.of(0xe0, 0x04, 0x00, 0x00, 0x00));
    assert.equal(more.length, 0);
    assert.equal(report.length, 64);
    assert.deepEqual([...report.subarray(0, 12)], [0x01, 0x01, 0x05, 0x00, 0x00, 0x00, 0x05, 0xe0, 0x04, 0x00, 0x00, 0x00]);
    assert.ok(report.subarray(12).every((b) => b === 0));
});

test('a long APDU goes in numbered reports, 57 bytes in the first and 59 after, and reads back whole', () => {
    const apdu = bytes(260);
    const reports = frames(apdu);
    assert.equal(reports.length, Math.ceil((260 + 2) / 59));
    reports.forEach((r, i) => assert.equal(new DataView(r.buffer).getUint16(3), i));
    assert.deepEqual([...reports[0].subarray(7)], [...apdu.subarray(0, 57)]);
    assert.deepEqual([...reports[1].subarray(5)], [...apdu.subarray(57, 116)]);
    const read = reader();
    const answers = reports.map((r) => read(r));
    assert.ok(answers.slice(0, -1).every((a) => a === null));
    assert.deepEqual(answers.at(-1), apdu);
});

test('reading skips reports on another channel and refuses one out of order, of another tag or of a bad length', () => {
    const [first, second] = frames(bytes(100));
    const read = reader();
    assert.equal(read(frames(bytes(100), 0x0202)[0]), null);
    assert.equal(read(first), null);
    assert.deepEqual(read(second), bytes(100));

    assert.throws(() => reader()(second), trouble('garbled'));
    const tagged = first.slice();
    tagged[2] = 0x02;
    assert.throws(() => reader()(tagged), trouble('garbled'));
    for (const length of [0, 1, 2000]) {
        const bad = first.slice();
        new DataView(bad.buffer).setUint16(5, length);
        assert.throws(() => reader()(bad), trouble('garbled'));
    }
    assert.throws(() => reader()(first.subarray(0, 6)), trouble('garbled'));
});

test('a conversation opens the device, gets each answer whole and closes it', async () => {
    const ledger = fakeLedger((apdu) => Uint8Array.from([...bytes(apdu.length > 5 ? 64 : 32, 9), ...OK]));
    const answers = await talk(ledger, async (exchange) => [await exchange(Uint8Array.of(0xe0, 0x05, 0, 0, 0)), await exchange(bytes(260))]);
    assert.deepEqual(ledger.log, ['open', 'apdu 5', 'apdu 260', 'close']);
    assert.equal(answers[0].length, 34);
    assert.equal(answers[1].length, 66);
    assert.deepEqual([...answers[1].subarray(64)], OK);
    assert.equal(ledger.listeners, 0);
    assert.equal(ledger.opened, false);
});

test('the device is closed after a conversation that fails', async () => {
    const ledger = fakeLedger(() => Uint8Array.of(0x90)); // one byte: no status word
    await assert.rejects(
        talk(ledger, (exchange) => exchange(bytes(5))),
        trouble('garbled'),
    );
    assert.deepEqual(ledger.log, ['open', 'apdu 5', 'close']);
});

test('a device another app holds is busy; one that goes away while talking is unplugged', async () => {
    await assert.rejects(
        talk(fakeLedger(() => null, { open: true }), (exchange) => exchange(bytes(5))),
        trouble('busy'),
    );
    const gone = fakeLedger(() => null, { send: true });
    await assert.rejects(
        talk(gone, (exchange) => exchange(bytes(5))),
        trouble('unplugged'),
    );
    assert.deepEqual(gone.log, ['open', 'close']);
    assert.equal(gone.listeners, 0);
});

test('one conversation at a time: a second one while the first waits is busy at once', async () => {
    const ledger = fakeLedger(() => null);
    const stop = new AbortController();
    const first = talk(ledger, (exchange) => exchange(bytes(5)), stop.signal);
    await new Promise((r) => setTimeout(r));
    await assert.rejects(
        talk(fakeLedger(() => Uint8Array.from(OK)), (exchange) => exchange(bytes(5))),
        trouble('busy'),
    );
    stop.abort();
    await assert.rejects(first, trouble('cancelled'));
    const after = await talk(fakeLedger(() => Uint8Array.from(OK)), (exchange) => exchange(bytes(5)));
    assert.deepEqual([...after], OK);
});

test('a wait ends with the signal: cancelled, silent on a timeout, or the LedgerError given', async () => {
    const silent = fakeLedger(() => null);
    await assert.rejects(
        talk(silent, (exchange) => exchange(bytes(5)), AbortSignal.timeout(20)),
        trouble('silent'),
    );
    assert.deepEqual(silent.log, ['open', 'apdu 5', 'close']);
    assert.equal(silent.listeners, 0);

    const unplugged = new AbortController();
    unplugged.abort(new LedgerError('unplugged', 'gone'));
    const never = fakeLedger(() => null);
    await assert.rejects(
        talk(never, (exchange) => exchange(bytes(5)), unplugged.signal),
        trouble('unplugged'),
    );
    assert.deepEqual(never.log, [], 'not even opened');
});

test('an APDU given a wait ends silent after it; a try stopped before it starts never takes the device', async () => {
    const silent = fakeLedger(() => null);
    await assert.rejects(
        talk(silent, (exchange) => exchange(bytes(5), 20)),
        trouble('silent'),
    );
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(talk(fakeLedger(() => null), (exchange) => exchange(bytes(5)), stopped.signal), trouble('cancelled'));
    const next = await talk(fakeLedger(() => Uint8Array.from(OK)), (exchange) => exchange(bytes(5))); // not busy
    assert.deepEqual([...next], OK);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getPublicKeyFromAddress, verifySignature, type Address } from '@solana/kit';

import { type Exchange } from '../src/ledger/hid.ts';
import { ledgers, onLedgerOf, pair, talkTo, type Hid, type HidDevice } from '../src/ledger/devices.ts';
import { address, pathBytes, sign, solanaApp } from '../src/ledger/solana.ts';
import { fakeApp, hidDevice, OK, PATH, trouble } from './ledger-fakes.ts';

test('paths: hardened levels under 44\'/501\', two to five, as the app takes them', () => {
    assert.deepEqual([...pathBytes(PATH)], [4, 0x80, 0, 0, 0x2c, 0x80, 0, 0x01, 0xf5, 0x80, 0, 0, 0, 0x80, 0, 0, 0]);
    assert.deepEqual([...pathBytes("m/44'/501'")], [2, 0x80, 0, 0, 0x2c, 0x80, 0, 0x01, 0xf5]);
    assert.equal(pathBytes("44'/501'/2147483647'").length, 13);
    for (const bad of ["44'/501'/0", "44'/60'/0'", "44'", "44'/501'/0'/0'/0'/0'", "44'/501'/2147483648'", "44'/501'/-1'", "44'/501'/'", "44'/501'/0'/", '']) {
        assert.throws(() => pathBytes(bad), /not a Solana derivation path/, bad);
    }
});

test('the Solana app open: its blind signing setting and version; any other app, or the dashboard, is closed', async () => {
    assert.deepEqual(await solanaApp((await fakeApp({ blind: true })).exchange), { blindSigning: true, version: '1.17.1' });
    assert.deepEqual(await solanaApp((await fakeApp()).exchange), { blindSigning: false, version: '1.17.1' });
    for (const app of ['BOLOS', 'Ethereum']) await assert.rejects(solanaApp((await fakeApp({ app })).exchange), trouble('closed'));
});

test('the address at a path, read quietly or shown on the device', async () => {
    const { exchange, owner, log } = await fakeApp();
    assert.equal(await address(exchange, PATH), owner);
    assert.equal(await address(exchange, PATH, true), owner);
    assert.deepEqual(log, ['e0 5 0 0', 'e0 5 1 0']);
    const shown = await fakeApp({ reject: true });
    await assert.rejects(address(shown.exchange, PATH, true), trouble('rejected'));
});

async function verified(owner: Address, signature: Uint8Array, message: Uint8Array) {
    return verifySignature(await getPublicKeyFromAddress(owner), signature as never, message);
}

test('a short message is signed in one APDU', async () => {
    const { exchange, owner, log } = await fakeApp();
    const message = Uint8Array.from({ length: 150 }, (_, i) => i);
    const signature = await sign(exchange, PATH, message);
    assert.ok(await verified(owner, signature, message));
    assert.deepEqual(log, ['e0 6 1 0']);
});

test('a long message goes in chunks of 255: more, then extend and more, then extend', async () => {
    const { exchange, owner, log } = await fakeApp();
    const message = Uint8Array.from({ length: 1232 }, (_, i) => (i * 7) % 256);
    message[0] = 0x80; // v0
    const signature = await sign(exchange, PATH, message);
    assert.ok(await verified(owner, signature, message));
    const chunks = Math.ceil((1 + 17 + 1232) / 255);
    assert.deepEqual(log, ['e0 6 1 2', ...Array(chunks - 2).fill('e0 6 1 3'), 'e0 6 1 1']);
});

test('v1 messages never reach the device', async () => {
    const { exchange, log } = await fakeApp();
    await assert.rejects(sign(exchange, PATH, Uint8Array.of(0x81, 1, 0, 0)), trouble('refused'));
    assert.deepEqual(log, []);
});

test("the device's answers in words: rejected, blind signing off, locked, another app, another key, anything else", async () => {
    const message = Uint8Array.of(1, 0, 1, 2);
    await assert.rejects(sign((await fakeApp({ reject: true })).exchange, PATH, message), trouble('rejected'));
    await assert.rejects(sign((await fakeApp({ blindOnly: true })).exchange, PATH, message), trouble('blind'));
    assert.equal((await sign((await fakeApp({ blindOnly: true, blind: true })).exchange, PATH, message)).length, 64);
    for (const [status, t] of [
        [0x5515, 'locked'],
        [0x6b0c, 'locked'],
        [0x6e00, 'closed'],
        [0x6e01, 'closed'],
        [0x6d00, 'closed'],
        [0x6511, 'closed'],
        [0x6a81, 'stranger'],
        [0x6a80, 'refused'],
    ] as const) {
        await assert.rejects(sign((await fakeApp({ status })).exchange, PATH, message), trouble(t), status.toString(16));
    }
    await assert.rejects(sign((await fakeApp({ status: 0x6a80 })).exchange, PATH, message), /Your Ledger refused it \(6a80\)/);
    await assert.rejects(solanaApp((await fakeApp({ status: 0x5515 })).exchange), trouble('locked'));
});

test('answers of the wrong size are garbled', async () => {
    const short: Exchange = async () => Uint8Array.from([1, 2, 3, ...OK]);
    await assert.rejects(address(short, PATH), trouble('garbled'));
    await assert.rejects(sign(short, PATH, Uint8Array.of(1, 0, 1, 2)), trouble('garbled'));
    const chatty: Exchange = async () => Uint8Array.from([1, ...OK]); // data where a middle chunk takes none
    await assert.rejects(sign(chatty, PATH, new Uint8Array(600)), trouble('garbled'));
});

/** navigator.hid with these devices granted and plugged in; requestDevice gives the chosen ones. */
function fakeHid(devices: HidDevice[], chosen: HidDevice[] = devices): Hid {
    return {
        getDevices: async () => devices,
        requestDevice: async () => chosen,
        addEventListener: () => {},
        removeEventListener: () => {},
    };
}

test('the Ledgers Otus may talk to: its vendor, the interface that takes APDUs', async () => {
    const app = (await fakeApp()).exchange;
    const flex = hidDevice(app);
    const fido = hidDevice(app, { usagePages: [0xf1d0] });
    const other = hidDevice(app, { vendorId: 0x1209 });
    const bare = hidDevice(app, { usagePages: [] });
    assert.deepEqual(await ledgers(fakeHid([fido, flex, other, bare])), [flex, bare]);
    assert.equal(await pair(fakeHid([], [fido, flex])), flex);
    assert.equal(await pair(fakeHid([], [])), null);
    assert.deepEqual(await ledgers(undefined), []);
});

test("an account's work runs on the Ledger that holds it, once the Solana app is open there", async () => {
    const theirs = await fakeApp();
    const mine = await fakeApp();
    const hid = fakeHid([hidDevice(theirs.exchange), hidDevice(mine.exchange)]);
    const message = Uint8Array.of(1, 0, 1, 2);
    const signature = await onLedgerOf({ address: mine.owner, path: PATH }, (exchange) => sign(exchange, PATH, message), undefined, hid);
    assert.ok(await verified(mine.owner, signature, message));
    assert.ok(!theirs.log.some((l) => l.startsWith('e0 6')), 'nothing to sign on the other Ledger');
});

test('when no Ledger holds the account: the most telling trouble, else another key, else none plugged in', async () => {
    const owner = (await fakeApp()).owner;
    const key = { address: owner, path: PATH };
    const work = async () => 'done';
    const other = hidDevice((await fakeApp()).exchange);
    const locked = hidDevice((await fakeApp({ status: 0x5515 })).exchange);
    const dashboard = hidDevice((await fakeApp({ app: 'BOLOS' })).exchange);
    await assert.rejects(onLedgerOf(key, work, undefined, fakeHid([other])), trouble('stranger'));
    await assert.rejects(onLedgerOf(key, work, undefined, fakeHid([other, dashboard, locked])), trouble('locked'));
    await assert.rejects(onLedgerOf(key, work, undefined, fakeHid([dashboard, other])), trouble('closed'));
    await assert.rejects(onLedgerOf(key, work, undefined, fakeHid([])), trouble('unplugged'));
});

test("the work's own refusal ends the search: rejected on the device is final", async () => {
    const mine = await fakeApp({ reject: true });
    const hid = fakeHid([hidDevice(mine.exchange)]);
    await assert.rejects(
        onLedgerOf({ address: mine.owner, path: PATH }, (exchange) => sign(exchange, PATH, Uint8Array.of(1, 0, 1, 2)), undefined, hid),
        trouble('rejected'),
    );
});

test('reads that ask nothing of the user wait 5 s at most; what the user answers on the device waits for them', async () => {
    const { exchange } = await fakeApp();
    const waits: (number | undefined)[] = [];
    const watched: Exchange = (apdu, wait) => (waits.push(wait), exchange(apdu, wait));
    await solanaApp(watched);
    await address(watched, PATH);
    await address(watched, PATH, true);
    await sign(watched, PATH, Uint8Array.of(1, 0, 1, 2));
    assert.deepEqual(waits, [5000, 5000, 5000, undefined, undefined]);
});

/** navigator.hid whose devices can be unplugged: `unplug` tells the listeners. */
function pluggedHid(devices: HidDevice[]) {
    const listeners = new Set<(e: { device: HidDevice }) => void>();
    const hid: Hid = { ...fakeHid(devices), addEventListener: (_, l) => void listeners.add(l), removeEventListener: (_, l) => void listeners.delete(l) };
    return { hid, unplug: (device: HidDevice) => listeners.forEach((l) => l({ device })), listeners };
}

test('a conversation ends unplugged when its own Ledger goes, not when another does', async () => {
    const silent: Exchange = () => new Promise(() => {}); // a device waiting on its user
    const mine = hidDevice(silent);
    const other = hidDevice(silent);
    const { hid, unplug, listeners } = pluggedHid([mine, other]);
    const talking = talkTo(mine, (exchange) => exchange(Uint8Array.of(0xe0, 0x06, 1, 0, 0)), undefined, hid);
    await new Promise((r) => setTimeout(r, 10));
    unplug(other);
    await new Promise((r) => setTimeout(r, 10));
    unplug(mine);
    await assert.rejects(talking, trouble('unplugged'));
    assert.equal(listeners.size, 0);
});

test('a search stopped by its signal asks no other Ledger', async () => {
    const first = await fakeApp();
    const second = await fakeApp();
    const stop = new AbortController();
    const hid = fakeHid([hidDevice(first.exchange), hidDevice(second.exchange)]);
    const searching = onLedgerOf({ address: second.owner, path: PATH }, async () => 'done', stop.signal, hid);
    stop.abort();
    await assert.rejects(searching, trouble('cancelled'));
    assert.deepEqual(second.log, []);
});

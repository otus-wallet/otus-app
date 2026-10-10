import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lookOutside, outsideKey, type Looked, type Outside } from '../src/outside.ts';

const WALLET = 'HH2vCgeHY4PNpYfACYSAAr11P1chxbMsSYbY7VzAHVx2';
const PAYER = 'AxJkHRY3puoofyj7Pn512M1SGBgWroXMkEdNPQypkzbu';

// A transaction at a slot: signed by the wallet (with signature `mine`), by another payer as well, or not by the wallet.
const tx = (slot: number, mine: string | null, payer = false, time: number | null = 1_800_000_000 + slot): Looked => ({
    signature: `tx${slot}`,
    slot: BigInt(slot),
    time,
    signatures: { ...(payer && { [PAYER]: `payer${slot}` }), ...(mine && { [WALLET]: mine }) },
});
const at = (seen: number, o: Partial<Outside> = {}): Outside => ({ seen: String(seen), gaps: [], flagged: [], unseen: false, ...o });
const look = (read: Looked[], before: Outside | undefined, here: string[] = [], more = false, since?: number) => lookOutside(read, WALLET, before, new Set(here), since, more);

test('never checked: what shows counts as seen, or what landed since the wallet came into Otus is checked', () => {
    const read = [tx(30, 'x30'), tx(20, 'x20'), tx(10, 'x10')];
    assert.deepEqual(look(read, undefined), { now: at(30), found: [] });
    // Imported at slot 20's time: the one after it, signed elsewhere, is found; the ones before stay the past.
    const { now, found } = look(read, undefined, [], false, 1_800_000_020);
    assert.deepEqual(found, ['tx30', 'tx20']);
    assert.deepEqual(now, at(30, { flagged: ['tx30', 'tx20'], unseen: true }));
    // A new wallet with nothing yet: whatever it signs later is checked.
    assert.deepEqual(look([], undefined), { now: at(0), found: [] });
    assert.deepEqual(look([tx(5, 'x5')], at(0)).found, ['tx5']);
});

test('above the mark: signed by the wallet and not by Otus is found; Otus’s own, and what only reaches it, are not', () => {
    const read = [tx(60, 'x60'), tx(55, null), tx(50, 'x50', true), tx(45, 'x45', true), tx(40, 'x40'), tx(30, 'x30')];
    // x40 and x45 Otus signed (x45 with another payer: its id is the payer's); 55 only sent the wallet something.
    const { now, found } = look(read, at(30), ['x40', 'x45']);
    assert.deepEqual(found, ['tx60', 'tx50']);
    assert.deepEqual(now, at(60, { flagged: ['tx60', 'tx50'], unseen: true }));
    // Read again, nothing new: the same, nothing found twice.
    assert.deepEqual(look(read, now, ['x40', 'x45']), { now, found: [] });
    // Seen in Activity (unseen cleared by the popup), a later one marks it again.
    assert.deepEqual(look([tx(70, 'x70'), ...read], { ...now, unseen: false }, ['x40', 'x45']).now.unseen, true);
});

test('more landed than a page holds: the stretch below is checked as the next pages are read', () => {
    const first = [tx(300, 'x300'), tx(250, 'x250'), tx(200, 'x200')];
    const one = look(first, at(100), ['x300', 'x250', 'x200'], true);
    assert.deepEqual(one.now.gaps, [['100', '200']]);
    // The next page reaches into the stretch: what it holds is checked, the stretch left is below it.
    const two = look([...first, tx(180, 'x180'), tx(150, 'x150')], one.now, ['x300', 'x250', 'x200', 'x150'], true);
    assert.deepEqual(two.found, ['tx180']);
    assert.deepEqual(two.now.gaps, [['100', '150']]);
    // Down past the mark: nothing left to check.
    const three = look([...first, tx(180, 'x180'), tx(150, 'x150'), tx(120, 'x120'), tx(90, 'x90')], two.now, ['x300', 'x250', 'x200', 'x150', 'x120'], true);
    assert.deepEqual([three.found, three.now.gaps], [[], []]);
    // The end of the history reached: no stretch either, however far the last page goes.
    assert.deepEqual(look(first, at(100), [], false).now.gaps, []);
});

test('a page read before the mark moved (kept from before): no stretch made, none closed that it does not reach', () => {
    const before = at(300, { gaps: [['100', '200']] });
    // An older page, of slots 150 to 120: it checks those, and leaves the stretch above and below what it holds.
    const { now, found } = look([tx(150, 'x150'), tx(120, 'x120')], before, [], true);
    assert.deepEqual(found, ['tx150', 'tx120']);
    assert.deepEqual(now.gaps, [['150', '200'], ['100', '120']]);
    assert.equal(now.seen, '300');
    // Nothing read: everything kept.
    assert.deepEqual(look([], before).now, before);
});

test('bounded: the latest 50 found kept, at most 4 stretches, slots past 2^53 exact', () => {
    const many = Array.from({ length: 70 }, (_, i) => tx(1000 - i, `m${i}`));
    const { now } = look(many, at(0));
    assert.equal(now.flagged.length, 50);
    assert.equal(now.flagged.at(-1), 'tx931');
    const gaps = Array.from({ length: 6 }, (_, i) => [String(i * 100), String(i * 100 + 50)] as [string, string]);
    assert.equal(look([tx(5000, null)], at(4000, { gaps }), [], true).now.gaps.length, 4);
    const big = 2n ** 60n;
    const far = { signature: 'far', slot: big + 1n, time: null, signatures: { [WALLET]: 'f' } };
    assert.deepEqual(look([far], at(0, { seen: big.toString() })), { now: { ...at(0, { seen: (big + 1n).toString() }), flagged: ['far'], unseen: true }, found: ['far'] });
    assert.equal(outsideKey('solana:mainnet', WALLET), `solana:mainnet ${WALLET}`);
});

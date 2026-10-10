import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lookOutside, outsideKey, unchecked, type Looked, type Outside } from '../src/outside.ts';

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
const NOW = 1_800_100_000;
const look = (read: Looked[], before: Outside | undefined, here: string[] = [], more = false, since?: number) => lookOutside({ read, wallet: WALLET, before, here: new Set(here), since, more, now: NOW });

test('never checked: what shows counts as seen, or what landed since the wallet came into Otus is checked', () => {
    const read = [tx(30, 'x30'), tx(20, 'x20'), tx(10, 'x10')];
    assert.deepEqual(look(read, undefined), { now: at(30), found: [] });
    // Imported at slot 20's time: the one after it, signed elsewhere, is found; the ones before stay the past.
    const { now, found } = look(read, undefined, [], false, 1_800_000_020);
    assert.deepEqual(found, ['tx30', 'tx20']);
    assert.deepEqual(now, at(30, { flagged: ['tx30', 'tx20'], unseen: true, from: 1_800_000_020 }));
    // A new wallet with nothing yet: whatever it signs later is checked, and what landed before it came never is.
    assert.deepEqual(look([], undefined, [], false, 1_800_000_004), { now: at(0, { from: 1_800_000_004 }), found: [] });
    assert.deepEqual(look([tx(5, 'x5'), tx(3, 'x3')], at(0, { from: 1_800_000_004 })).found, ['tx5']);
    // Nothing read and no time it came (an empty answer, maybe): from a little before now, not the whole history.
    assert.deepEqual(look([], undefined).now, at(0, { from: NOW - 3600 }));
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
    assert.deepEqual(one.now.gaps, [['100', '201']]); // slot 200 left in: the next page may hold more of it
    // The next page reaches into the stretch: what it holds is checked, the stretch left is below it.
    const two = look([...first, tx(180, 'x180'), tx(150, 'x150')], one.now, ['x300', 'x250', 'x200', 'x150'], true);
    assert.deepEqual(two.found, ['tx180']);
    assert.deepEqual(two.now.gaps, [['100', '151']]);
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
    assert.deepEqual(now.gaps, [['150', '200'], ['100', '121']]);
    assert.equal(now.seen, '300');
    // Nothing read: everything kept.
    assert.deepEqual(look([], before).now, before);
});

test('bounded: the latest 50 found kept, at most 4 stretches, slots past 2^53 exact', () => {
    const many = Array.from({ length: 70 }, (_, i) => tx(1000 - i, `m${i}`));
    const { now } = look(many, at(0));
    assert.equal(now.flagged.length, 50);
    assert.equal(now.flagged.at(-1), 'tx931');
    // Past four stretches, the lowest become one: none dropped unchecked.
    const gaps = Array.from({ length: 6 }, (_, i) => [String(i * 100), String(i * 100 + 50)] as [string, string]);
    // (one more from what this read leaves: it holds one transaction, and more follows)
    assert.deepEqual(look([tx(5000, null)], at(4000, { gaps }), [], true).now.gaps, [['4000', '5001'], ['500', '550'], ['400', '450'], ['0', '350']]);
    const big = 2n ** 39n; // past 2^32, under what is believed
    const far = { signature: 'far', slot: big + 1n, time: null, signatures: { [WALLET]: 'f' } };
    assert.deepEqual(look([far], at(0, { seen: big.toString() })), { now: { ...at(0, { seen: (big + 1n).toString() }), flagged: ['far'], unseen: true }, found: ['far'] });
    assert.equal(outsideKey('solana:mainnet', WALLET), `solana:mainnet ${WALLET}`);
});

test('a transaction in the slot a page ends in is checked with the next page (a bundle, then spam)', () => {
    // M, signed elsewhere, lands in slot 500 with four more; then 21 transfers to the wallet. The first page ends in slot 500.
    const spam = Array.from({ length: 21 }, (_, i) => tx(521 - i, null));
    const bundle = [1, 2, 3, 4].map((i) => ({ ...tx(500, null), signature: `s${i}` }));
    const first = look([...spam, ...bundle], at(450), [], true);
    assert.deepEqual([first.found, first.now.seen, first.now.gaps], [[], '521', [['450', '501']]]);
    assert.equal(unchecked(first.now), true);
    const m = { ...tx(500, 'mine'), signature: 'M' };
    const second = look([...spam, ...bundle, m, tx(460, null), tx(440, null)], first.now, [], true);
    assert.deepEqual([second.found, second.now.gaps, unchecked(second.now)], [['M'], [], false]);
});

test('imported with a long history: the stretch since it came is checked down to what landed before', () => {
    const page = Array.from({ length: 25 }, (_, i) => tx(1000 - i * 10, null)); // all since it came
    const first = look(page, undefined, [], true, 1_800_000_000);
    assert.deepEqual(first.now.gaps, [['-1', '761']]);
    // The next page reaches what landed before it came: nothing below is checked, nor left to.
    const second = look([...page, tx(700, 'old', false, 1_799_999_000), tx(690, 'older', false, 1_799_998_000)], first.now, [], true);
    assert.deepEqual([second.found, second.now.gaps], [[], []]);
});

test('a slot past any Solana reaches is not believed: it never moves the mark', () => {
    const lie = { ...tx(1, 'x'), slot: 2n ** 64n - 1n };
    assert.deepEqual(look([lie, tx(40, null)], at(30)), { now: at(40), found: [] });
});

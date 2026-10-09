import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { acquaintance, edited, lookalike, named, sentTo, signs, type State } from '../src/state.ts';
import { key } from './helpers.ts';

const [MINE, WATCHED, FRIEND, STRANGER] = [key(1), key(2), key(3), key(4)];
const state = (part: Partial<State> = {}): State => ({
    accounts: [{ address: MINE, label: 'Main', key: { secret: 's', index: 0 } }, { address: WATCHED, label: 'Cold' }],
    active: MINE,
    sites: {},
    contacts: [],
    sent: {},
    removed: [],
    waiting: [],
    given: [],
    settings: DEFAULT_SETTINGS,
    ...part,
});
// An edit made on a state, as the background makes it.
const after = (s: State, e: Parameters<typeof edited>[0]) => ({ ...s, ...(edited(e, s) ?? {}) });

test('an address you know is kept by your name for it, renamed by keeping it again, and dropped', () => {
    let s = after(state(), { edit: 'keep', address: FRIEND, label: '  Ana‮  ' });
    assert.deepEqual(s.contacts, [{ address: FRIEND, label: 'Ana' }]);
    s = after(s, { edit: 'keep', address: FRIEND, label: 'Ana M.' });
    assert.deepEqual(s.contacts, [{ address: FRIEND, label: 'Ana M.' }]);
    assert.deepEqual(after(s, { edit: 'drop', address: FRIEND }).contacts, []);
    // Nothing to keep: not an address, no name, or one of your accounts, watched or not; nothing to drop.
    for (const e of [
        { edit: 'keep', address: 'nope', label: 'X' },
        { edit: 'keep', address: STRANGER, label: '​ ' },
        { edit: 'keep', address: MINE, label: 'X' },
        { edit: 'keep', address: WATCHED, label: 'X' },
        { edit: 'drop', address: STRANGER },
    ] as const) assert.equal(edited(e, s), null, JSON.stringify(e));
    // A book of 200 takes no more, though it still renames.
    const full = state({ contacts: Array.from({ length: 200 }, (_, i) => ({ address: key(10 + i), label: `C${i}` })) });
    assert.equal(edited({ edit: 'keep', address: STRANGER, label: 'One more' }, full), null);
    assert.ok(edited({ edit: 'keep', address: key(10), label: 'Renamed' }, full));
});

test('what Otus knows of an address you send to: yours, watched, kept, how many times you sent to it', () => {
    let s = state({ contacts: [{ address: FRIEND, label: 'Ana' }] });
    assert.deepEqual(acquaintance(s, MINE), { label: 'Main', as: 'account', sent: 0 });
    assert.deepEqual(acquaintance(s, WATCHED), { label: 'Cold', as: 'watched', sent: 0 });
    assert.deepEqual(acquaintance(s, FRIEND), { label: 'Ana', as: 'contact', sent: 0 });
    assert.deepEqual(acquaintance(s, STRANGER), { label: null, as: null, sent: 0 });
    s = { ...s, ...sentTo(s, STRANGER) };
    s = { ...s, ...sentTo(s, STRANGER) };
    assert.deepEqual(acquaintance(s, STRANGER), { label: null, as: null, sent: 2 });
    assert.equal(acquaintance(s, 'constructor').sent, 0); // only counts kept
});

test('an address that only looks like one you know: the same start and end, another middle, as address poisoners make them', () => {
    const ANA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const s = state({ contacts: [{ address: ANA as never, label: 'Ana' }], sent: { DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy: 1 } });
    const forged = (head: string, tail: string, of: string) => `${head}${'z'.repeat(of.length - head.length - tail.length)}${tail}`;
    assert.deepEqual(lookalike(s, forged('7xKX', 'gAsU', ANA)), { address: ANA, label: 'Ana' });
    assert.deepEqual(lookalike(s, forged('7xK', 'sU', ANA)), null); // five alike: chance, about once in 6 × 10^8
    assert.deepEqual(lookalike(s, forged('7xKXtg', 'U', ANA)), null); // one at the end is not enough
    assert.deepEqual(lookalike(s, forged('DRp', '21hy', 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy')), { address: 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy', label: null });
    assert.equal(lookalike(s, ANA), null); // the address itself
    assert.equal(lookalike(s, key(9)), null);
    assert.deepEqual(lookalike(s, forged(MINE.slice(0, 4), MINE.slice(-4), MINE)), { address: MINE, label: 'Main' }); // yours too
});

test('nothing kept that passes for what you know: an address like another, a name another has; yours now, no longer kept', () => {
    const ANA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const s = state({ contacts: [{ address: ANA as never, label: 'Ana' }] });
    const forgedMain = `${MINE.slice(0, 4)}${'2'.repeat(MINE.length - 8)}${MINE.slice(-4)}`;
    assert.equal(edited({ edit: 'keep', address: forgedMain, label: 'Savings' }, s), null); // looks like your wallet Main
    assert.equal(edited({ edit: 'keep', address: STRANGER, label: 'main' }, s), null); // Main's name, any case
    assert.equal(edited({ edit: 'keep', address: STRANGER, label: 'ＡＮＡ' }, s), null); // Ana's, fullwidth
    assert.ok(edited({ edit: 'keep', address: ANA, label: 'Ana' }, s)); // keeping Ana again, as Ana
    // Kept before it could be refused: both say so.
    const both = { ...s, contacts: [...s.contacts, { address: forgedMain as never, label: 'Main 2' }] };
    assert.deepEqual(lookalike(both, forgedMain), { address: MINE, label: 'Main' });
    assert.deepEqual(lookalike(both, MINE), { address: forgedMain, label: 'Main 2' });
    // Watched, an address you kept is one of your accounts.
    assert.deepEqual(after(s, { edit: 'watch', address: ANA, label: 'Ana' }).contacts, []);
    // Watched or renamed, the same checks: the Send picker lists it among your wallets.
    assert.equal(edited({ edit: 'watch', address: forgedMain, label: 'Vault' }, s), null);
    assert.equal(edited({ edit: 'watch', address: STRANGER, label: 'Main' }, s), null);
    assert.equal(edited({ edit: 'rename', address: WATCHED, label: 'MAIN' }, s), null);
    assert.ok(edited({ edit: 'rename', address: WATCHED, label: 'Cold storage' }, s));
    // Watched with no name: the first free one, whatever was removed before.
    const named2 = state({ accounts: [{ address: MINE, label: 'Account 2' }] });
    assert.equal(after(named2, { edit: 'watch', address: STRANGER, label: '' }).accounts.at(-1)?.label, 'Account 3');
});

test('a Ledger account: its address and path as the device gave them; a watched one becomes it, keeping its name', () => {
    const PATH = "44'/501'/0'/0'";
    const added = after(state({ contacts: [{ address: FRIEND, label: 'Ana' }] }), { edit: 'ledger', address: FRIEND, path: PATH, label: 'Ledger 1' });
    assert.deepEqual(added.accounts.at(-1), { address: FRIEND, label: 'Ledger 1', ledger: { path: PATH } });
    assert.equal(added.active, FRIEND);
    assert.deepEqual(added.contacts, []); // yours now, no longer an address you keep
    assert.ok(signs(added.accounts.at(-1)!));
    assert.equal(acquaintance(added, FRIEND).as, 'account');

    const watched = after(state(), { edit: 'ledger', address: WATCHED, path: "44'/501'", label: 'Ledger 1' });
    assert.deepEqual(watched.accounts.find((a) => a.address === WATCHED), { address: WATCHED, label: 'Cold', ledger: { path: "44'/501'" } });
    assert.equal(watched.accounts.length, 2);
    assert.equal(after(state(), { edit: 'ledger', address: STRANGER, path: PATH, label: '' }).accounts.at(-1)?.label, 'Account 3');
});

test('a Ledger account is refused when Otus signs for it already, for a path the Solana app would not take, or when it passes for another', () => {
    const PATH = "44'/501'/0'/0'";
    const s = state();
    assert.equal(edited({ edit: 'ledger', address: MINE, path: PATH, label: 'L' }, s), null); // its key is in the vault
    const twice = after(s, { edit: 'ledger', address: STRANGER, path: PATH, label: 'L' });
    assert.equal(edited({ edit: 'ledger', address: STRANGER, path: "44'/501'/1'/0'", label: 'L2' }, twice), null);
    for (const path of ["44'/501'/0", "m/44'/501'/0'", "44'/60'/0'", "44'/501'/0'/0'/0'/0'", '', 7, null]) {
        assert.equal(edited({ edit: 'ledger', address: STRANGER, path, label: 'L' } as never, s), null, String(path));
    }
    assert.equal(edited({ edit: 'ledger', address: 'not an address', path: PATH, label: 'L' }, s), null);
    const forgedMain = `${MINE.slice(0, 4)}${'2'.repeat(MINE.length - 8)}${MINE.slice(-4)}`;
    assert.equal(edited({ edit: 'ledger', address: forgedMain, path: PATH, label: 'L' }, s), null);
    assert.equal(edited({ edit: 'ledger', address: STRANGER, path: PATH, label: 'main' }, s), null); // Main's name
});

test('a name is kept as text that shows, cut by characters', () => {
    assert.equal(named('  Ana \u202E\u200B M. '), 'Ana M.');
    assert.equal(named('\u3164\u3164'), ''); // Hangul fillers draw nothing
    assert.equal(named('\u2800'), ''); // a blank Braille pattern
    assert.equal(named('A\u2028B'), 'AB');
    assert.equal(named(`${'x'.repeat(31)}😀😀`), `${'x'.repeat(31)}😀`); // not half an emoji
    assert.equal(named(42), '');
});

test('the wallet in use takes every connected site with it, unless it is watch-only', () => {
    const [one, two, watched] = [key(1), key(2), key(3)];
    const s = state({
        accounts: [
            { address: one, label: 'One', key: { index: 0 } },
            { address: two, label: 'Two', key: { index: 1 } },
            { address: watched, label: 'Watched' },
        ] as State['accounts'],
        active: one,
        sites: { 'https://a.example': { account: one, signatures: 3, since: 1 }, 'https://b.example': { account: two, signatures: 0 } },
    });
    const moved = after(s, { edit: 'use', address: two });
    assert.equal(moved.active, two);
    assert.deepEqual(moved.sites, { 'https://a.example': { account: two, signatures: 3, since: 1 }, 'https://b.example': { account: two, signatures: 0 } });
    const watching = after(moved, { edit: 'use', address: watched });
    assert.equal(watching.active, watched);
    assert.deepEqual(watching.sites, moved.sites, 'a watch-only wallet signs nothing: the sites stay');
});

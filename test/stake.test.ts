import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getStakeStateAccountEncoder } from '@solana-program/stake';
import { getBase58Encoder, type Address } from '@solana/kit';

import { NEVER, lockedOf, stakeOf, standingOf, type StakeAccount } from '../src/stake/stakes.ts';
import { namesOf, ranked } from '../src/stake/validators.ts';
import { about, search, stakeProblem, standingWords, validatorWords } from '../src/ui/view/stake.ts';
import { key } from './helpers.ts';

const SYSTEM = '11111111111111111111111111111111' as Address;
const lockup = { unixTimestamp: 0n, epoch: 0n, custodian: SYSTEM };
const meta = (owner: Address) => ({ rentExemptReserve: 1_666_240n, authorized: { staker: owner, withdrawer: owner }, lockup });
const delegated = (vote: Address, activation: bigint, deactivation = NEVER) => ({ delegation: { voterPubkey: vote, stake: 1_000_000_000n, activationEpoch: activation, deactivationEpoch: deactivation, reserved: Array(8).fill(0) }, creditsObserved: 0n });

test('a stake account is read only when its size and layout fit; where it stands follows its epochs', () => {
    const me = key(1);
    // 197 bytes of state, in an account of 200: the rest is padding.
    const bytes = new Uint8Array(200);
    bytes.set(getStakeStateAccountEncoder().encode({ state: { __kind: 'Stake', fields: [meta(me), delegated(key(40), 10n), { bits: 0 }] } }));
    const s = stakeOf(key(30), 1_001_666_240n, bytes) as StakeAccount;
    assert.deepEqual([s.vote, s.delegated, s.withdrawer, s.reserve], [key(40), 1_000_000_000n, me, 1_666_240n]);
    assert.equal(standingOf(s, 10n), 'activating');
    assert.equal(standingOf(s, 11n), 'active');
    assert.equal(standingOf({ ...s, deactivation: 12n }, 12n), 'deactivating');
    assert.equal(standingOf({ ...s, deactivation: 12n }, 13n), 'inactive');
    assert.equal(standingOf({ ...s, activation: 12n, deactivation: 12n }, 12n), 'inactive'); // unstaked the epoch it started: off at once
    assert.equal(standingOf({ ...s, vote: null }, 12n), 'idle');
    // Too short, too long, or garbage: unreadable, never guessed.
    for (const odd of [bytes.subarray(0, 199), new Uint8Array([...bytes, 0]), new Uint8Array(200).fill(7)]) assert.ok('unreadable' in stakeOf(key(30), 5n, odd));
    // A lockup holds it back from all but its custodian, until its epoch and its time.
    const locked = { ...s, lockup: { epoch: 20n, time: 0n, custodian: key(6) } };
    assert.ok(lockedOf(locked, 19n, 0n, me) && !lockedOf(locked, 20n, 0n, me) && !lockedOf({ ...locked, lockup: { ...locked.lockup, custodian: me } }, 19n, 0n, me));
});

test('where a stake stands, and how long until it changes, in words', () => {
    assert.equal(about(25 * 60), '~25 min');
    assert.equal(about(13.4 * 3600), '~13 h');
    assert.equal(about(52 * 3600), '~2 d 4 h');
    assert.equal(about(48 * 3600), '~2 d');
    assert.equal(standingWords('activating', 3600, false), 'Starts earning in ~1 h');
    assert.equal(standingWords('deactivating', null, false), 'Unstaking: ready next epoch');
    assert.equal(standingWords('inactive', null, false), 'Ready to withdraw');
    assert.equal(standingWords('inactive', null, true), 'Unstaked, locked by its custodian');
});

const vote = (n: number, stake: bigint, commission = 5, credits: [bigint, bigint, bigint][] = [[9n, 1000n, 0n]]) => ({ votePubkey: key(100 + n), nodePubkey: key(200 + n), commission, activatedStake: stake, epochCredits: credits });

test('validators rank by what they paid of late, voting first; the largest that hold a third are marked, not left out', () => {
    const current = [vote(1, 500n, 0, [[8n, 900n, 0n], [9n, 1900n, 900n], [10n, 1950n, 1900n]]), vote(2, 300n, 10), vote(3, 100n, 0), vote(4, 50n, 100)];
    const list = ranked(current, [vote(5, 50n, 0)], 10n, new Map());
    // Epoch 10 is under way: only 8 and 9 count. 1: (900 + 1000) * 100; 3: 1000 * 100; 2: 1000 * 90; 4 keeps it all.
    assert.deepEqual(list.map((v) => v.vote), [key(101), key(103), key(102), key(104), key(105)]);
    assert.deepEqual(list.map((v) => v.score), [190_000n, 100_000n, 90_000n, 0n, 100_000n]);
    assert.deepEqual(list.filter((v) => v.top).map((v) => v.vote), [key(101)]); // 500 of 1,000: past a third alone
    assert.equal(list.at(-1)!.voting, false);
});

// A validator info account: its two keys, then its JSON as a u64 length and text.
function info(node: Address, json: string, { keys = 2, signed = 1 } = {}): Uint8Array {
    const text = new TextEncoder().encode(json);
    const b58 = getBase58Encoder();
    const data = new Uint8Array(1 + 66 + 8 + text.length);
    data[0] = keys;
    data.set(b58.encode('Va1idator1nfo111111111111111111111111111111'), 1);
    data.set(b58.encode(node), 34);
    data[66] = signed;
    new DataView(data.buffer).setBigUint64(67, BigInt(text.length), true);
    data.set(text, 75);
    return data;
}

test('validator names are what each identity signed, made safe to show; a name two use is marked on both', () => {
    const names = namesOf([
        info(key(201), '{"name":"Helius","website":"x"}'),
        info(key(202), '{"name":"helius"}'),
        info(key(203), '{"name":"Seven\\u200b \\u202eStar"}'),
        info(key(204), '{"name":"A"}'),
        info(key(204), '{"name":"B"}'), // two names for one identity: neither
        info(key(205), '{"name":"Unsigned"}', { signed: 0 }),
        info(key(206), '{"name":"Three keys"}', { keys: 3 }),
        info(key(207), '{"name": 7}'),
        info(key(208), 'not json'),
        new Uint8Array(40),
    ]);
    assert.deepEqual([...names], [
        [key(201), 'Helius'],
        [key(202), 'helius'],
        [key(203), 'Seven Star'],
    ]);
    const list = ranked([vote(1, 10n), vote(2, 10n), vote(3, 10n)], [], 10n, names);
    assert.deepEqual(list.map((v) => [v.name, v.twin]), [['Helius', true], ['helius', true], ['Seven Star', false]]);
});

test('a search finds validators by name or address, and lists only voting ones without one', () => {
    const list = ranked([vote(1, 10n), vote(2, 10n)], [vote(3, 10n)], 10n, new Map([[key(201), 'Helius'], [key(203), 'Gone']]));
    assert.deepEqual(search(list, '').map((v) => v.vote), [key(101), key(102)]);
    assert.deepEqual(search(list, 'heli').map((v) => v.vote), [key(101)]);
    assert.deepEqual(search(list, 'gone').map((v) => v.voting), [false]); // a search shows those not voting too
    assert.deepEqual(search(list, key(102).slice(0, 6)).map((v) => v.vote), [key(102)]);
    assert.deepEqual(search(list, key(202)).map((v) => v.vote), [key(102)]); // by its identity
    const [gone] = search(list, 'gone');
    assert.deepEqual(validatorWords(gone).notes, [{ text: 'Not voting now: it earns no rewards', tone: 'danger' }]);
});

test('what keeps a new stake from going on, in words', () => {
    const f = { min: 1_000_000_000n, most: 4_000_000_000n };
    assert.equal(stakeProblem({ ...f, text: '1,5', units: null }), 'Use a point for decimals: 0.05, not 0,05');
    assert.equal(stakeProblem({ ...f, text: 'x', units: null }), 'An amount above 0, with at most 9 decimals');
    assert.equal(stakeProblem({ ...f, text: '0.5', units: 500_000_000n }), "At least 1 SOL: the network's minimum");
    assert.equal(stakeProblem({ ...f, text: '5', units: 5_000_000_000n }), 'At most 4 SOL: some stays for rent and fees');
    assert.equal(stakeProblem({ ...f, text: '2', units: 2_000_000_000n }), '');
    assert.equal(stakeProblem({ ...f, most: 0n, text: '2', units: 2_000_000_000n }), 'Not enough SOL: some stays for rent and fees');
});

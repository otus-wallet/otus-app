import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getStakeStateAccountEncoder } from '@solana-program/stake';
import { getBase58Encoder, type Address } from '@solana/kit';

import { NEVER, lockedOf, nextSeed, stakeOf, stakeRent, stakesOf, standingOf, type StakeAccount } from '../src/stake/stakes.ts';
import { namesOf, ranked, skeleton } from '../src/stake/validators.ts';
import { about, search, stakeProblem, standingWords, validatorWords } from '../src/view/stake.ts';
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
    // A lockup holds it back until its epoch and its time (its custodian could sign too; Otus's withdraw has only the wallet).
    const locked = { ...s, lockup: { epoch: 20n, time: 0n, custodian: me } };
    assert.ok(lockedOf(locked, 19n, 0n) && !lockedOf(locked, 20n, 0n));
    assert.ok(lockedOf({ ...s, lockup: { epoch: 0n, time: 100n, custodian: key(6) } }, 30n, 99n) && !lockedOf({ ...s, lockup: { epoch: 0n, time: 100n, custodian: key(6) } }, 30n, 100n));
    // A genesis stake: active from the start.
    assert.equal(standingOf({ ...s, activation: NEVER }, 5n), 'active');
});

test('the stake accounts read are the ones the wallet withdraws from, as their layout says', async () => {
    const me = key(1);
    const account = (withdrawer: Address) => {
        const d = new Uint8Array(200);
        d.set(getStakeStateAccountEncoder().encode({ state: { __kind: 'Stake', fields: [{ ...meta(me), authorized: { staker: me, withdrawer } }, delegated(key(40), 10n), { bits: 0 }] } }));
        return [Buffer.from(d).toString('base64'), 'base64'];
    };
    const rpc = { getProgramAccounts: () => ({ send: async () => [{ pubkey: key(30), account: { lamports: 2n, data: account(me) } }, { pubkey: key(31), account: { lamports: 9n, data: account(key(6)) } }] }) };
    assert.deepEqual((await stakesOf(rpc as never, me)).map((s) => s.address), [key(30)]);
});

test('rent is read off the Rent sysvar and cut as the runtime cuts it; the next seed skips what is there or was just used', async () => {
    const rent = new Uint8Array(17);
    new DataView(rent.buffer).setBigUint64(0, 2540n, true);
    new DataView(rent.buffer).setFloat64(8, 2.0, true);
    const rpc = (data: Uint8Array) => ({ getAccountInfo: () => ({ send: async () => ({ value: { data: [Buffer.from(data).toString('base64'), 'base64'] } }) }) });
    assert.equal(await stakeRent(rpc(rent) as never), 1_666_240n);
    await assert.rejects(stakeRent(rpc(rent.subarray(0, 16)) as never));
    const taken = new Set(['stake:0', 'stake:1']); // there onchain
    const seeds = { getMultipleAccounts: (addresses: string[]) => ({ send: async () => ({ value: addresses.map((a) => (taken.has(a) ? {} : null)) }) }) };
    const at = async (seed: string) => seed as Address;
    assert.equal(await nextSeed(seeds as never, at, (n) => `stake:${n}`), 'stake:2');
    assert.equal(await nextSeed(seeds as never, at, (n) => `stake:${n}`, new Set(['stake:2'])), 'stake:3');
    const full = { getMultipleAccounts: (addresses: string[]) => ({ send: async () => ({ value: addresses.map(() => ({})) }) }) };
    assert.match(await nextSeed(full as never, at, (n) => `stake:${n}`), /^stake:[0-9a-f]{16}$/); // all hundred filled: a random one
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
    // Only the last complete epochs count: credits from long ago, before an absence, count for nothing.
    const back = ranked([vote(6, 10n, 0, [[790n, 300n, 0n], [791n, 600n, 300n], [792n, 900n, 600n], [800n, 1000n, 900n]]), vote(7, 10n, 0, [[797n, 290n, 0n], [798n, 580n, 290n], [799n, 870n, 580n]])], [], 800n, new Map());
    assert.deepEqual(back.map((v) => [v.vote, v.score]), [[key(107), 87_000n], [key(106), 0n]]);
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
    // Names drawn alike are alike: another script's letters, a 1 for an i, accents, a number at the end.
    for (const like of ['Неlius', 'Hel1us', 'Hélius', 'Helius 2', 'HELIUS.', 'He\u0301\u0301\u0301lius']) assert.equal(skeleton(like), skeleton('Helius'), like);
    assert.notEqual(skeleton('Helios'), skeleton('Helius'));
    assert.equal(skeleton('AB'), ''); // too little to tell apart
    // Marks piled on a letter, past two, are dropped from the name shown.
    assert.equal(namesOf([info(key(209), '{"name":"Ze\u0301\u0302\u0303\u0304\u0305d"}')]).get(key(209)), 'Z\u00e9\u0302\u0303d'); // é composed, then two marks
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

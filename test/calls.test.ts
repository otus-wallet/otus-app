import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AccountRole, address, type Address, type Instruction } from '@solana/kit';

import type { Chain, Simulation } from '../src/chain.ts';
import { review } from '../src/review/review.ts';
import { prepare } from '../src/send/prepare.ts';
import { account, fakeChain, key, PAYER, SYSTEM, transaction } from './helpers.ts';

const JUPITER = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const KAMINO = address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const PHOENIX = address('PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY');
const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TENSOR = address('TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp');
const BUBBLEGUM = address('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY');
const STRANGER = key(70);
const context = { wallet: PAYER, signedBefore: 0, host: 'app.example.com' };

// One instruction of `top` with your signature, and the calls the simulation lists inside it: [program, depth].
type Calls = [Address, number?][];
const signed = (top: Address): Instruction => ({ programAddress: top, accounts: [{ address: PAYER, role: AccountRole.WRITABLE_SIGNER }], data: new Uint8Array([1]) });
const inner = (calls: Calls): Simulation['inner'] => [{ index: 0, calls: calls.map(([program, depth]) => ({ program, type: null, ...(depth && { depth }) })) }];
const chainOf = (simulation: Partial<Simulation> = {}) => fakeChain([account(PAYER, SYSTEM, 5_000_000n)], [account(PAYER, SYSTEM, 4_995_000n)], simulation);

test('where your signature reaches, call by call: a program Otus doesn’t know calling Kamino Lend, however deep', async () => {
    const reaching = async (top: Address, calls: Calls) =>
        (await review(transaction([signed(top)]), context, chainOf({ inner: inner(calls) }))).assessment.findings
            .filter((f) => f.code === 'reaches-holdings')
            .map((f) => `${f.subject}: ${f.text}`);
    // Jupiter calling Kamino Lend itself: what Otus knows, calling what it knows.
    assert.deepEqual(await reaching(JUPITER, [[TOKEN, 2], [KAMINO, 2]]), []);
    // Jupiter calling a program Otus doesn't know, and that one Kamino Lend: there your signature goes.
    assert.deepEqual(await reaching(JUPITER, [[STRANGER, 2], [TOKEN, 3], [KAMINO, 3]]), [`${STRANGER}: An unknown program uses your signature in Kamino Lend`]);
    // A level up again, Kamino Lend is Jupiter's call.
    assert.deepEqual(await reaching(JUPITER, [[STRANGER, 2], [TOKEN, 3], [KAMINO, 2]]), []);
    // Above it through one Otus knows: Tensor's call to Bubblegum is the unknown program's doing too.
    assert.deepEqual(await reaching(STRANGER, [[TENSOR, 2], [BUBBLEGUM, 3]]), [`${STRANGER}: An unknown program uses your signature in Metaplex Bubblegum`]);
    // An RPC that gives no depth: any program before a call may have made it.
    assert.deepEqual(await reaching(STRANGER, [[TOKEN], [KAMINO]]), [`${STRANGER}: An unknown program uses your signature in Kamino Lend`]);
    assert.deepEqual(await reaching(JUPITER, [[STRANGER], [KAMINO]]), [`${STRANGER}: An unknown program uses your signature in Kamino Lend`]);
    assert.deepEqual(await reaching(JUPITER, [[TOKEN], [KAMINO]]), []);
});

test('guarded, a program Otus doesn’t know calling what it didn’t in the review is critical; known ones, the chain moving on', async () => {
    // The review's simulation lists `seen`; every one after it, of the transaction as Otus guards it, `guarded`.
    const prepared = async (top: Address, seen: Calls, guarded: Calls, listed = true) => {
        const base = chainOf();
        let first = true;
        const simulate: Chain['simulate'] = async (...args) => {
            const s = { ...(await base.simulate(...args)), inner: inner(first ? seen : guarded), innerListed: !first || listed };
            first = false;
            return s;
        };
        const chain = { ...base, simulate };
        const p = await prepare(await review(transaction([signed(top)]), context, chain), PAYER, chain);
        return p.findings.map((f) => `${f.level}:${f.code} ${f.note}`);
    };
    assert.deepEqual(await prepared(STRANGER, [[TOKEN, 2]], [[TOKEN, 2]]), []);
    assert.deepEqual(await prepared(STRANGER, [[TOKEN, 2]], [[TOKEN, 2], [KAMINO, 2]]), ['danger:guards-differ It then calls Kamino Lend, which the review did not see']);
    assert.deepEqual(await prepared(JUPITER, [[TOKEN, 2]], [[STRANGER, 2], [TOKEN, 3]]), [`danger:guards-differ It then calls ${STRANGER.slice(0, 4)}…${STRANGER.slice(-4)}, Token Program, which the review did not see`]);
    // Jupiter filling through Phoenix this time: both known.
    assert.deepEqual(await prepared(JUPITER, [[TOKEN, 2]], [[PHOENIX, 2], [TOKEN, 3]]), []);
    // A review whose RPC listed no calls has nothing to compare with: the review says so itself.
    assert.deepEqual(await prepared(STRANGER, [], [[KAMINO, 2]], false), []);
});

test('guarded, a call made where it was not, under the instruction it is in: a decoy in another one hides nothing', async () => {
    // Instruction 0: the program without your signature calls Kamino Lend (a refresh anyone may ask). Instruction 1: with
    // it, it calls Kamino Lend only once guarded.
    const unsigned: Instruction = { programAddress: STRANGER, accounts: [{ address: key(71), role: AccountRole.WRITABLE }], data: new Uint8Array([2]) };
    const groups = (guarded: boolean): Simulation['inner'] => [{ index: 0, calls: [{ program: KAMINO, type: null, depth: 2 }] }, ...(guarded ? [{ index: 1, calls: [{ program: KAMINO, type: null, depth: 2 }] }] : [])];
    const base = chainOf();
    let first = true;
    const simulate: Chain['simulate'] = async (...args) => {
        const s = { ...(await base.simulate(...args)), inner: groups(!first) };
        first = false;
        return s;
    };
    const chain = { ...base, simulate };
    const p = await prepare(await review(transaction([unsigned, signed(STRANGER)]), context, chain), PAYER, chain);
    assert.deepEqual(p.findings.map((f) => f.code), ['guards-differ']);
});

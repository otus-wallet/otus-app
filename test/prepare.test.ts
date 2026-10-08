import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMPUTE_BUDGET_PROGRAM_ADDRESS, getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction, getSetLoadedAccountsDataSizeLimitInstruction } from '@solana-program/compute-budget';
import { getAdvanceNonceAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { AccountRole, address, createNoopSigner, getAddressEncoder, getI64Encoder, getU32Encoder, getU64Encoder, type Address, type Instruction, type MaybeEncodedAccount } from '@solana/kit';

import type { Chain, Simulation } from '../src/chain.ts';
import type { Context } from '../src/review/assess.ts';
import { dataLimit, defaultUnits, priorityFee, unitLimit, unitPrice } from '../src/review/budget.ts';
import { decode, durable, type Message } from '../src/review/decode.ts';
import { LOOKUP_TABLE_PROGRAM, resolve } from '../src/review/resolve.ts';
import { review } from '../src/review/review.ts';
import { LIGHTHOUSE } from '../src/programs/addresses.ts';
import { prepare, type Prepared } from '../src/send/prepare.ts';
import {
    account,
    EVIL_PROGRAM,
    fakeChain,
    key,
    lookupTable,
    MINT,
    PAYER,
    RECIPIENT,
    SYSTEM,
    TABLE,
    TRANSFER_DATA,
    tokenAccountData,
    transaction,
    transactionWithTable,
    transfer,
    transferV1,
    transferWithTable,
    USER_TOKEN,
} from './helpers.ts';

const context: Context = { wallet: PAYER, signedBefore: 0 };
const payer = createNoopSigner(PAYER);
const pay = getTransferSolInstruction({ source: payer, destination: RECIPIENT, amount: 1_000_000n });
const TABLE_ACCOUNT = account(TABLE, LOOKUP_TABLE_PROGRAM, 1n, lookupTable([RECIPIENT]));
const bytes = (...parts: ArrayLike<number>[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const u64 = (v: bigint) => getU64Encoder().encode(v);
const keyOf = (a: Address) => getAddressEncoder().encode(a);
const messageOf = async (p: Prepared) => (await decode(p.bytes)).message;
const guardsOn = (m: Message, target: Address) =>
    m.instructions.filter((ix) => m.staticAccounts[ix.programAddressIndex] === LIGHTHOUSE && m.staticAccounts[ix.accountIndices[0]] === target).map((ix) => ix.data);
const touching = (...writable: Address[]): Instruction => ({
    programAddress: EVIL_PROGRAM,
    accounts: [{ address: PAYER, role: AccountRole.WRITABLE_SIGNER }, ...writable.map((address) => ({ address, role: AccountRole.WRITABLE }))],
});

/** Reviews and prepares a transaction whose simulation moves 1,000,000 lamports out of the wallet and charges its fee. */
async function prepared(tx: Uint8Array, simulation: Partial<Simulation> = {}, rest: Partial<Chain> = {}): Promise<Prepared> {
    const fee = simulation.fee ?? 5_000n;
    const chain = fakeChain(
        [account(PAYER, SYSTEM, 5_000_000n), TABLE_ACCOUNT],
        [account(PAYER, SYSTEM, 4_000_000n - fee), account(RECIPIENT, SYSTEM, 1_000_000n)],
        simulation,
        rest,
    );
    return prepare(await review(tx, context, chain), PAYER, chain);
}

/** Reviews and prepares a transaction over accounts that stay as given, or change to `after`. */
async function preparedOver(tx: Uint8Array, before: MaybeEncodedAccount[], after = before): Promise<Prepared> {
    const chain = fakeChain(before, after);
    return prepare(await review(tx, context, chain), PAYER, chain);
}

test('holds the wallet to its simulated balance, owner and size, in a new last instruction', async () => {
    const p = await prepared(transfer());
    assert.deepEqual([p.unguarded, p.findings], [null, []]);
    // 1,000,000 lamports out, 1% drift allowed as nothing comes back, then the 5,000 fee.
    assert.deepEqual(p.holds, [{ kind: 'wallet', account: PAYER, atLeast: 3_985_000n, owner: SYSTEM, space: 0 }]);
    const m = await messageOf(p);
    assert.deepEqual(m.staticAccounts, [PAYER, RECIPIENT, SYSTEM, LIGHTHOUSE, COMPUTE_BUDGET_PROGRAM_ADDRESS]);
    assert.equal(m.header.numReadonlyNonSignerAccounts, 3);
    assert.deepEqual(m.instructions[0], { programAddressIndex: 2, accountIndices: [0, 1], data: TRANSFER_DATA });
    assert.deepEqual(guardsOn(m, PAYER), [bytes([6, 0, 3, 0], u64(3_985_000n), [4, 1], u64(0n), [0, 2], keyOf(SYSTEM), [0])]);
    assert.equal(unitLimit(m), 204_000); // the runtime's default made explicit, and 4,000 for the guard
});

test('accounts from a lookup table move one place when a program is added', async () => {
    const p = await prepared(transferWithTable());
    const r = await resolve(await decode(p.bytes), fakeChain([TABLE_ACCOUNT]));
    const [original] = r.message.instructions;
    assert.deepEqual(original.accountIndices.map((i) => r.accounts[i].address), [PAYER, RECIPIENT]);
    assert.deepEqual(guardsOn(r.message, PAYER).length, 1);
});

test('fits the compute limit to the simulation, and prices it from recent fees under a cap', async () => {
    const fees = async () => [9n, 1n, 8n, 2n, 7n, 3n, 6n, 4n, 5n, 0n].map((f) => f * 1_000n);
    const p = await prepared(transfer(), { unitsConsumed: 150_000n }, { fees });
    const m = await messageOf(p);
    // 150,000 used as it will be signed, and a tenth more; the 75th percentile of recent prices.
    assert.deepEqual([unitLimit(m), unitPrice(m)], [165_000, 6_000n]);
    assert.deepEqual(m.staticAccounts.slice(-2), [LIGHTHOUSE, COMPUTE_BUDGET_PROGRAM_ADDRESS]);
    assert.equal(p.holds[0].atLeast, 3_990_000n - 5_000n - 990n); // 6,000 micro-lamports × 165,000 units

    const pricey = await prepared(transfer(), { unitsConsumed: 150_000n }, { fees: async () => [10n ** 12n] });
    assert.equal(priorityFee(await messageOf(pricey)), 1_000_000n);

    const v1 = await prepared(transferV1({ computeUnitLimit: 200_000, loadedAccountsDataSizeLimit: 32_768 }), { loadedBytes: 20_000 }, { fees: async () => [2_000_000n] });
    assert.deepEqual((await messageOf(v1)).config, { computeUnitLimit: 204_000, priorityFeeLamports: 408_000n, loadedAccountsDataSizeLimit: 32_768 }); // a total in v1
    assert.equal(defaultUnits((await decode(transferV1({}))).message), 0); // v1 runs nothing without a limit
});

test('the limit is fitted to the transaction as it will be signed, its guards and fee settings included', async () => {
    // The network: 150,000 units for the transaction as the site sent it, 2,700 more with the guard and fee settings.
    const base = fakeChain([account(PAYER, SYSTEM, 5_000_000n)], [account(PAYER, SYSTEM, 3_995_000n)], { unitsConsumed: 150_000n });
    const chain: Chain = {
        ...base,
        fees: async () => [5_000n],
        simulate: async (tx, watch, slot) => {
            const s = await base.simulate(tx, watch, slot);
            const guarded = (await decode(tx)).message.staticAccounts.includes(LIGHTHOUSE);
            return { ...s, unitsConsumed: guarded ? 152_700n : 150_000n };
        },
    };
    const r = await review(transfer(), context, chain);
    const m = await messageOf(await prepare(r, PAYER, chain));
    assert.equal(unitLimit(m), Math.ceil(152_700 * 1.1));
});

test('prices a unit as the RPC recommends when it can, from recent blocks otherwise', async () => {
    const fees = async () => [1_000n, 2_000n, 3_000n, 4_000n];
    const priced = async (recommended: Chain['recommended']) => {
        const p = await prepared(transfer(), { unitsConsumed: 150_000n }, { fees, recommended });
        return [unitPrice(await messageOf(p)), p.priced];
    };
    assert.deepEqual(await priced(async () => 25_000n), [25_000n, 'recommended']);
    assert.deepEqual(await priced(async () => null), [3_000n, 'recent']); // an RPC that has none: the 75th percentile
    assert.deepEqual(await priced(async () => assert.fail('Method not found')), [3_000n, 'recent']);
});

test('keeps the fee the site set, adding the units the guards use', async () => {
    const fees = () => assert.fail('the site set its own price');
    const tx = transaction([getSetComputeUnitLimitInstruction({ units: 200_000 }), getSetComputeUnitPriceInstruction({ microLamports: 1_000_000n }), pay]);
    const p = await prepared(tx, { fee: 205_000n, unitsConsumed: 150_000n }, { fees });
    assert.deepEqual([unitLimit(await messageOf(p)), unitPrice(await messageOf(p))], [204_000, 1_000_000n]);
    assert.equal(p.holds[0].atLeast, 3_795_000n - 4_000n - 10_000n); // the guard's 4,000 units at 1 lamport each, and 1% drift

    const v1 = await prepared(transferV1({ computeUnitLimit: 200_000, priorityFeeLamports: 7n, loadedAccountsDataSizeLimit: 32_768 }), { loadedBytes: 20_000 }, { fees });
    assert.deepEqual((await messageOf(v1)).config, { computeUnitLimit: 204_000, priorityFeeLamports: 7n, loadedAccountsDataSizeLimit: 32_768 });
});

test('a v1 transaction with guards may load the account data they need: measured, a tenth more, by 32 KiB, never less than the site set', async () => {
    const fees = async () => [0n];
    const room = async (site: number | undefined, loadedBytes: number | null) => {
        const p = await prepared(transferV1({ computeUnitLimit: 200_000, ...(site !== undefined && { loadedAccountsDataSizeLimit: site }) }), { loadedBytes }, { fees });
        return [(await messageOf(p)).config.loadedAccountsDataSizeLimit, p.room];
    };
    // Lighthouse's program is some 424 KB: a site's 32 KiB, enough before, is not with guards.
    assert.deepEqual(await room(32_768, 427_034), [491_520, 491_520]);
    assert.deepEqual(await room(1_048_576, 427_034), [1_048_576, null]); // room enough already
    assert.deepEqual(await room(32_768, null), [67_108_864, 67_108_864]); // an RPC that does not say: the most there is
    // Legacy and v0 load what they need.
    assert.equal((await prepared(transfer(), { loadedBytes: 427_034 }, { fees })).room, null);
});

test('in a trade, amounts may land a tenth away from the simulation; nothing else may move', async () => {
    const usdc = (amount: bigint) => account(USER_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount }));
    const p = await preparedOver(transaction([touching(USER_TOKEN)]), [account(PAYER, SYSTEM, 5_000_000n), usdc(0n)], [account(PAYER, SYSTEM, 3_995_000n), usdc(150_000_000n)]);
    // 1 SOL out may cost up to 1.1 SOL; 150 tokens in must bring at least 135.
    assert.deepEqual(p.holds.map((h) => h.atLeast), [3_900_000n - 5_000n, 135_000_000n]);
});

test('holds a token account of yours that the simulation leaves untouched, its delegate and close authority too', async () => {
    const held = account(USER_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 1000n }));
    const p = await preparedOver(transaction([touching(USER_TOKEN)]), [account(PAYER, SYSTEM, 5_000_000n), held], [account(PAYER, SYSTEM, 4_995_000n), held]);
    assert.deepEqual(p.holds[1], { kind: 'token', account: USER_TOKEN, atLeast: 1000n, owner: PAYER, delegate: null, delegated: 0n, closer: null });
    assert.deepEqual(guardsOn(await messageOf(p), USER_TOKEN), [bytes([10, 0, 5, 2], u64(1000n), [4, 1], keyOf(PAYER), [0, 3, 0, 0, 6], u64(0n), [0, 7, 0, 0])]);
});

test('holds any other account with your address in it: its owner, size, lamports, and your address in place', async () => {
    const holder = key(90);
    const data = new Uint8Array(100);
    data.set(keyOf(PAYER), 40);
    const state = account(holder, EVIL_PROGRAM, 1_000_000n, data);
    const p = await preparedOver(transaction([touching(holder)]), [account(PAYER, SYSTEM, 5_000_000n), state], [account(PAYER, SYSTEM, 4_995_000n), state]);
    assert.deepEqual(p.holds[1], { kind: 'account', account: holder, atLeast: 1_000_000n, owner: EVIL_PROGRAM, space: 100, keys: [40] });
    assert.deepEqual(guardsOn(await messageOf(p), holder), [
        bytes([6, 0, 3, 0], u64(1_000_000n), [4, 1], u64(100n), [0, 2], keyOf(EVIL_PROGRAM), [0]),
        bytes([3, 0, 1, 40, 12], keyOf(PAYER), [0]),
    ]);
});

test('a durable transaction keeps AdvanceNonceAccount first', async () => {
    const tx = transaction([getAdvanceNonceAccountInstruction({ nonceAccount: key(40), nonceAuthority: payer }), pay]);
    const m = await messageOf(await prepared(tx, { unitsConsumed: 1_000n }, { fees: async () => [5n] }));
    assert.deepEqual([durable(m), m.instructions.length], [true, 5]);
});

test('says why it leaves a transaction as the site sent it, for the review’s Guards line; a finding only where it fails with guards', async () => {
    const cosigned = transaction([getTransferSolInstruction({ source: createNoopSigner(key(60)), destination: RECIPIENT, amount: 1n })]);
    const tabled = transactionWithTable([{ ...pay, accounts: [...pay.accounts!, { address: LIGHTHOUSE, role: AccountRole.READONLY }] }], [RECIPIENT, LIGHTHOUSE]);
    const chain = fakeChain([account(PAYER, SYSTEM, 5_000_000n), account(TABLE, LOOKUP_TABLE_PROGRAM, 1n, lookupTable([RECIPIENT, LIGHTHOUSE]))]);
    // Held to its outcome it fails; as the site sent it, it runs, or it fails too.
    const original = transfer();
    const failing = (alsoOriginal: boolean): Chain => ({
        ...chain,
        simulate: async (tx, watch, slot) => {
            const asSent = tx.length === original.length && tx.every((b, i) => b === original[i]);
            return { ...(await chain.simulate(tx, watch, slot)), error: watch.length > 0 || (asSent && !alsoOriginal) ? null : { InstructionError: [1, { Custom: 6400 }] } };
        },
    });
    const cases: [Uint8Array, Promise<Prepared>, RegExp, string[]][] = [
        [cosigned, prepared(cosigned), /^Another account signs it too/, []],
        [transfer(), prepared(transfer(), { error: 'AccountNotFound' }), /simulation failed/, []],
        [transfer('legacy', new Uint8Array(1000)), prepared(transfer('legacy', new Uint8Array(1000))), /too full/, []],
        [tabled, prepare(await review(tabled, context, chain), PAYER, chain), /format/, ['warn:blocks-guards']],
        [transfer(), prepared(transfer(), { unitsConsumed: 1n }, { fees: async () => Promise.reject(new Error('429')) }), /network didn't answer/, []],
        [original, prepare(await review(original, context, failing(false)), PAYER, failing(false)), /fails with guards/, ['danger:guards-fail']],
        [original, prepare(await review(original, context, failing(true)), PAYER, failing(true)), /fails with guards/, ['danger:simulation-failed']],
    ];
    for (const [sent, result, reason, findings] of cases) {
        const p = await result;
        assert.deepEqual([p.bytes, p.holds], [sent, []], String(reason));
        assert.match(p.unguarded ?? '', reason);
        assert.deepEqual(p.findings.map((f) => `${f.level}:${f.code}`), findings, String(reason));
    }
});

test('warns when the fee as prepared is high, though the site set it below the line', async () => {
    const tx = transaction([getSetComputeUnitLimitInstruction({ units: 5_000 }), getSetComputeUnitPriceInstruction({ microLamports: 980_000_000n }), pay]);
    const chain = fakeChain([account(PAYER, SYSTEM, 50_000_000n)], [account(PAYER, SYSTEM, 50_000_000n - 1_000_000n - 4_905_000n)], { fee: 4_905_000n, unitsConsumed: 1_000n });
    const check: Chain = { ...chain, simulate: async (t, w, s) => ({ ...(await chain.simulate(t, w, s)), ...(w.length === 0 && { fee: null }) }) };
    const p = await prepare(await review(tx, context, check), PAYER, check);
    assert.equal(p.fee, 5_000n + 9_000n * 980n); // 9,000 units at 980 lamports each
    assert.deepEqual(p.findings.map((f) => f.code), ['high-fee']);
});

test('Otus’s own transfer, v1 with the most of every limit for its review, gets them fitted as if it set none', async () => {
    const own = transferV1({ computeUnitLimit: 1_400_000, loadedAccountsDataSizeLimit: 64 * 1024 * 1024 });
    const chain = fakeChain(
        [account(PAYER, SYSTEM, 5_000_000n), TABLE_ACCOUNT],
        [account(PAYER, SYSTEM, 3_995_000n), account(RECIPIENT, SYSTEM, 1_000_000n)],
        { unitsConsumed: 150_000n, loadedBytes: 427_034 },
        { fees: async () => [2_000n] },
    );
    const p = await prepare(await review(own, context, chain), PAYER, chain, true);
    // 150,000 units and a tenth; 427,034 bytes and a tenth, by 32 KiB; 2,000 micro-lamports a unit, as a total.
    assert.deepEqual((await messageOf(p)).config, { computeUnitLimit: 165_000, loadedAccountsDataSizeLimit: 491_520, priorityFeeLamports: 330n });
    assert.deepEqual([p.units, p.room], [165_000, 491_520]);
    // A site's own limits stay what it set, the guards' room added.
    const site = await prepare(await review(own, context, chain), PAYER, chain);
    assert.equal((await messageOf(site)).config.computeUnitLimit, 1_400_000);
});

test('holds a stake account of yours whole: who stakes and withdraws, and its lockup, as reviewed', async () => {
    const STAKE = address('Stake11111111111111111111111111111111111111');
    const staked = key(91);
    const data = new Uint8Array(200);
    data.set(getU32Encoder().encode(2));
    data.set(keyOf(key(5)), 12); // a staking service stakes it
    data.set(keyOf(PAYER), 44); // you withdraw it
    const state = account(staked, STAKE, 3_000_000n, data);
    const p = await preparedOver(transaction([touching(staked)]), [account(PAYER, SYSTEM, 5_000_000n), state], [account(PAYER, SYSTEM, 4_995_000n), state]);
    const i64 = (v: bigint) => getI64Encoder().encode(v);
    assert.deepEqual(guardsOn(await messageOf(p), staked)[1], bytes([3, 0, 5, 12, 12], keyOf(key(5)), [0, 44, 12], keyOf(PAYER), [0, 76, 8], i64(0n), [0, 84, 7], u64(0n), [0, 92, 12], keyOf(SYSTEM), [0]));
});

test('a legacy or v0 transaction that limits its account data gets room for the guards, as v1 does; measured with no priority fee', async () => {
    const limited = transaction([getSetLoadedAccountsDataSizeLimitInstruction({ accountDataSizeLimit: 65_536 }), getSetComputeUnitLimitInstruction({ units: 200_000 }), getSetComputeUnitPriceInstruction({ microLamports: 50_000_000n }), pay]);
    const priced: bigint[] = []; // the priority fee of each transaction simulated
    const p = await prepared(limited, { loadedBytes: 427_034 }, {
        simulate: async (tx) => {
            priced.push(priorityFee((await decode(tx)).message));
            return { error: null, logs: [], fee: 5_000n, unitsConsumed: null, loaded: null, loadedBytes: 427_034, inner: [], innerListed: true, after: [account(PAYER, SYSTEM, 4_000_000n - 5_000n), account(RECIPIENT, SYSTEM, 1_000_000n)] };
        },
    });
    assert.deepEqual([dataLimit(await messageOf(p)), p.room], [491_520, 491_520]);
    assert.equal(priced[1], 0n); // the probe, after the review's own simulation: no fee for the most units
});

test('failing once guarded for what Otus adds goes as the site sent it; a guard failing, or a program fighting the guards, is critical', async () => {
    // The site's transaction runs as sent, using `used` units; with what Otus adds, it fails so.
    const original = transfer();
    const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
    const failing = (error: Simulation['error'], used: bigint) => async (tx: Uint8Array) => ({ error: same(tx, original) ? null : error, logs: [], fee: 5_000n, unitsConsumed: used, loaded: null, inner: [], innerListed: true, after: [account(PAYER, SYSTEM, 3_995_000n), account(RECIPIENT, SYSTEM, 1_000_000n)] });
    const said = async (error: Simulation['error'], used = 150_000n) => {
        const p = await prepared(original, {}, { simulate: failing(error, used) });
        return [p.unguarded, p.findings.map((f) => f.code)];
    };
    const full = ["It's too full for Otus to lock it", []];
    for (const error of ['MaxLoadedAccountsDataSizeExceeded', 'TooManyAccountLocks', { InsufficientFundsForRent: { account_index: 0 } }] as Simulation['error'][]) assert.deepEqual(await said(error), full, JSON.stringify(error));
    const spent = { InstructionError: [0, 'ComputationalBudgetExceeded'] } as Simulation['error'];
    assert.deepEqual(await said(spent, 1_396_000n), full); // the guards' units on top of nearly all there are
    // 150,000 units as sent, all 1,400,000 once guarded; another account left without its rent; a guard failing.
    for (const error of [spent, { InsufficientFundsForRent: { account_index: 1 } }, { InstructionError: [2, { Custom: 6400 }] }] as Simulation['error'][]) assert.deepEqual(await said(error), ['it fails with guards', ['guards-fail']], JSON.stringify(error));
});

test('short of units at the limit set, it gets the most there is and keeps its guards; a fee Otus adds that leaves the wallet without rent is dropped', async () => {
    // A program that behaves with all the units there are, and burns any lower limit it is given once guarded.
    const burner: Instruction = { programAddress: EVIL_PROGRAM, accounts: [{ address: key(50), role: AccountRole.READONLY }], data: new Uint8Array([1]) };
    const base = fakeChain([account(PAYER, SYSTEM, 5_000_000n)], [account(PAYER, SYSTEM, 3_995_000n), account(RECIPIENT, SYSTEM, 1_000_000n)]);
    const burning: Chain = {
        ...base,
        simulate: async (tx, watch, slot) => {
            const s = await base.simulate(tx, watch, slot);
            const m = (await decode(tx)).message;
            const limit = unitLimit(m);
            if (!m.staticAccounts.includes(LIGHTHOUSE)) return { ...s, unitsConsumed: 150_000n };
            if (limit === null || limit === 1_400_000) return { ...s, unitsConsumed: 152_000n };
            return { ...s, error: { InstructionError: [1, 'ComputationalBudgetExceeded'] }, unitsConsumed: BigInt(limit), after: [] };
        },
    };
    for (const tx of [transaction([pay, burner]), transaction([getSetComputeUnitLimitInstruction({ units: 150_100 }), pay, burner])]) {
        const p = await prepare(await review(tx, context, burning), PAYER, burning);
        assert.deepEqual([p.unguarded, p.units, guardsOn(await messageOf(p), PAYER).length], [null, 1_400_000, 1]);
    }
    // With Otus's priority fee the wallet would be left without its rent: the same, without that fee.
    const priced = fakeChain([account(PAYER, SYSTEM, 5_000_000n)], [account(PAYER, SYSTEM, 3_995_000n), account(RECIPIENT, SYSTEM, 1_000_000n)], { unitsConsumed: 1_000n }, { fees: async () => [5_000_000n] });
    const rent: Chain = { ...priced, simulate: async (tx, w, slot) => ({ ...(await priced.simulate(tx, w, slot)), ...(priorityFee((await decode(tx)).message) > 0n && { error: { InsufficientFundsForRent: { account_index: 0 } }, after: [] }) }) };
    const p = await prepare(await review(transfer(), context, rent), PAYER, rent);
    assert.deepEqual([p.unguarded, p.priority, priorityFee(await messageOf(p))], [null, null, 0n]);
});

test('a fee that Otus’s guards make huge, at the site’s own price, is critical', async () => {
    // 1,000 units at 49,000,000,000 micro-lamports each: 0.049 SOL as reviewed, 0.245 SOL with a guard's 4,000 units.
    const tx = transaction([getSetComputeUnitLimitInstruction({ units: 1_000 }), getSetComputeUnitPriceInstruction({ microLamports: 49_000_000_000n }), pay]);
    const chain = fakeChain([account(PAYER, SYSTEM, 5_000_000_000n)], [account(PAYER, SYSTEM, 5_000_000_000n - 1_000_000n - 49_005_000n), account(RECIPIENT, SYSTEM, 1_000_000n)], { fee: 49_005_000n, unitsConsumed: 900n });
    const check: Chain = { ...chain, simulate: async (t, w, s) => ({ ...(await chain.simulate(t, w, s)), ...(w.length === 0 && { fee: null }) }) };
    const p = await prepare(await review(tx, context, check), PAYER, check);
    assert.deepEqual(p.findings.map((f) => `${f.level}:${f.code}`), ['danger:high-fee']);
});

test('a transfer a Ledger shows in clear gets its limit and fee, and no guards: why, for the review', async () => {
    const chain = fakeChain(
        [account(PAYER, SYSTEM, 5_000_000n), TABLE_ACCOUNT],
        [account(PAYER, SYSTEM, 3_995_000n), account(RECIPIENT, SYSTEM, 1_000_000n)],
        { unitsConsumed: 150n },
        { fees: async () => [2_000n] },
    );
    const p = await prepare(await review(transfer(), context, chain), PAYER, chain, true, 'its Ledger shows it in clear');
    assert.deepEqual([p.holds, p.unguarded], [[], 'its Ledger shows it in clear']);
    const m = await messageOf(p);
    assert.ok(!m.staticAccounts.includes(LIGHTHOUSE));
    assert.equal(unitLimit(m), 165); // 150 and a tenth
    // Its limit and price first, then the transfer: the order a Ledger reads in clear.
    assert.deepEqual(m.instructions.map((ix) => m.staticAccounts[ix.programAddressIndex]), [COMPUTE_BUDGET_PROGRAM_ADDRESS, COMPUTE_BUDGET_PROGRAM_ADDRESS, SYSTEM]);
});

test('units are measured with a price instruction in place, as the transaction will be signed: each uses 150', async () => {
    const chain = fakeChain([account(PAYER, SYSTEM, 5_000_000n), TABLE_ACCOUNT], [account(PAYER, SYSTEM, 3_995_000n), account(RECIPIENT, SYSTEM, 1_000_000n)], { unitsConsumed: 450n }, { fees: async () => [2_000n] });
    const simulated: Uint8Array[] = [];
    const spied = { ...chain, simulate: (bytes: Uint8Array, ...rest: Parameters<Chain['simulate']> extends [unknown, ...infer R] ? R : never) => (simulated.push(bytes), chain.simulate(bytes, ...rest)) };
    await prepare(await review(transfer(), context, chain), PAYER, spied, true);
    const probe = (await decode(simulated[0])).message;
    const prices = probe.instructions.filter((ix) => probe.staticAccounts[ix.programAddressIndex] === COMPUTE_BUDGET_PROGRAM_ADDRESS && ix.data[0] === 3);
    assert.equal(prices.length, 1);
    assert.deepEqual([...prices[0].data.slice(1)], [0, 0, 0, 0, 0, 0, 0, 0]); // at zero: it costs nothing
});

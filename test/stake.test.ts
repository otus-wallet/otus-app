import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AccountRole, address, getAddressEncoder, getI64Encoder, getU32Encoder, getU64Encoder, type Address, type Instruction, type MaybeEncodedAccount } from '@solana/kit';

import { review } from '../src/review/review.ts';
import { account, fakeChain, key, PAYER, SYSTEM, transaction } from './helpers.ts';

const SOL = 1_000_000_000n;
const STAKE = address('Stake11111111111111111111111111111111111111');
const THIEF = address('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'); // a key someone holds
const EVIL = key(22);
const STAKED = key(43);
const context = { wallet: PAYER, signedBefore: 0, host: 'app.example.com' };
const { WRITABLE: W, READONLY_SIGNER: RS, WRITABLE_SIGNER: WS } = AccountRole;
// A plain System transfer of 4 SOL from you to this account.
const getTransferSolInstructionTo = (to: Address): Instruction => ({ programAddress: SYSTEM, accounts: [{ address: PAYER, role: WS }, { address: to, role: W }], data: new Uint8Array([2, 0, 0, 0, ...getU64Encoder().encode(4n * SOL)]) });

// A delegated stake account's data: staker and withdrawer, and a lockup (a time, an epoch, its custodian).
function staked(withdrawer: Address, lockup: { time?: bigint; epoch?: bigint; custodian?: Address } = {}): Uint8Array {
    const d = new Uint8Array(200);
    d.set(getU32Encoder().encode(2));
    d.set(getAddressEncoder().encode(withdrawer), 12);
    d.set(getAddressEncoder().encode(withdrawer), 44);
    d.set(getI64Encoder().encode(lockup.time ?? 0n), 76);
    d.set(getU64Encoder().encode(lockup.epoch ?? 0n), 84);
    d.set(getAddressEncoder().encode(lockup.custodian ?? SYSTEM), 92);
    return d;
}
const stakeAccount = (data: Uint8Array, lamports = 10n * SOL) => account(STAKED, STAKE, lamports, data);
const findings = async (ix: Instruction, before: MaybeEncodedAccount[], after: MaybeEncodedAccount[], codes: string[]) =>
    (await review(transaction([ix]), context, fakeChain(before, after))).assessment.findings.filter((f) => codes.includes(f.code)).map((f) => `${f.level}:${f.code}${f.note ? ` ${f.note}` : ''}`);

test('your stake under a lockup someone else keeps, new or changed, is critical; one you keep, or as it was, is not', async () => {
    const setLockup: Instruction = { programAddress: STAKE, accounts: [{ address: STAKED, role: W }, { address: PAYER, role: RS }], data: new Uint8Array([6, 0, 0, 0]) };
    const wallet = account(PAYER, SYSTEM, SOL);
    const locked = (before: Uint8Array, after: Uint8Array) => findings(setLockup, [wallet, stakeAccount(before)], [account(PAYER, SYSTEM, SOL - 5000n), stakeAccount(after)], ['stake-lockup']);
    const FUTURE = 2_000_000_000n; // 2033
    assert.deepEqual(await locked(staked(PAYER), staked(PAYER, { time: FUTURE, custodian: THIEF })), [`danger:stake-lockup ${THIEF} can lift it: until then you can't withdraw`]);
    assert.deepEqual(await locked(staked(PAYER), staked(PAYER, { epoch: 2000n })), ["danger:stake-lockup No one can lift it: you can't withdraw until it ends"]);
    assert.deepEqual(await locked(staked(PAYER), staked(PAYER, { time: FUTURE, custodian: PAYER })), []);
    // Its custodian already someone else's, the lockup run out: made longer, it holds your stake again.
    assert.deepEqual(await locked(staked(PAYER, { time: 1n, custodian: THIEF }), staked(PAYER, { time: FUTURE, custodian: THIEF })), [`danger:stake-lockup ${THIEF} can lift it: until then you can't withdraw`]);
    assert.deepEqual(await locked(staked(PAYER, { time: FUTURE, custodian: THIEF }), staked(PAYER, { time: FUTURE, custodian: THIEF })), []);
    // Someone else's stake is theirs to lock.
    assert.deepEqual(await locked(staked(THIEF), staked(THIEF, { time: FUTURE, custodian: EVIL })), []);
    // A new stake account of yours, made under someone else's lockup.
    const made = await findings(setLockup, [wallet], [account(PAYER, SYSTEM, SOL - 5000n), stakeAccount(staked(PAYER, { time: FUTURE, custodian: THIEF }))], ['stake-lockup']);
    assert.deepEqual(made, [`danger:stake-lockup ${THIEF} can lift it: until then you can't withdraw`]);
});

test('a stake account is whoever can withdraw it: your SOL into a thief’s goes to a wallet; into yours goes nowhere', async () => {
    const deposit: Instruction = { programAddress: EVIL, accounts: [{ address: PAYER, role: WS }, { address: STAKED, role: W }] };
    const into = (data: Uint8Array) =>
        findings(deposit, [account(PAYER, SYSTEM, 5n * SOL), stakeAccount(data, SOL)], [account(PAYER, SYSTEM, SOL - 5000n), stakeAccount(data, 5n * SOL)], ['sends-to-wallet', 'check-balances']);
    assert.deepEqual(await into(staked(THIEF)), ['danger:sends-to-wallet Through an unknown program, which Otus cannot read']);
    assert.deepEqual(await into(staked(PAYER)), []);
    // Yours, though someone else's lockup holds it: still not someone else's.
    assert.deepEqual(await into(staked(PAYER, { time: 2_000_000_000n, custodian: THIEF })), []);
});

test('your SOL into stake someone else keeps locked, made for you beforehand, is critical; a lockup run out is none', async () => {
    const deposit = getTransferSolInstructionTo(STAKED);
    const into = (data: Uint8Array) =>
        findings(deposit, [account(PAYER, SYSTEM, 5n * SOL), stakeAccount(data, SOL)], [account(PAYER, SYSTEM, SOL - 5000n), stakeAccount(data, 5n * SOL)], ['stake-lockup']);
    assert.deepEqual(await into(staked(PAYER, { time: 2_000_000_000n, custodian: THIEF })), [`danger:stake-lockup ${THIEF} can lift it: until then you can't withdraw`]);
    assert.deepEqual(await into(staked(PAYER, { time: 1_600_000_000n, custodian: THIEF })), []); // ran out in 2020
    assert.deepEqual(await into(staked(PAYER)), []);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getTransferSolInstruction } from '@solana-program/system';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { AccountRole, address, createNoopSigner, generateKeyPairSigner, getProgramDerivedAddress, type Address, type Instruction, type MaybeEncodedAccount } from '@solana/kit';

import type { Context } from '../src/review/assess.ts';
import { review } from '../src/review/review.ts';
import { account, fakeChain, key, MINT, PAYER, SYSTEM, tokenAccountData, transaction } from './helpers.ts';

const MARGINFI = address('MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA');
const THIEF = address('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'); // a key someone holds
const [VAULT, DEST, YOURS] = [key(40), key(41), key(43)];
const SOL = 1_000_000_000n;
const USDC = 1_000_000n; // a token of 6 decimals
const { WRITABLE: W, WRITABLE_SIGNER: WS } = AccountRole;
const tokens = (a: Address, owner: Address, amount: bigint) => account(a, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner, amount }));
const vaultOwner = async () => (await getProgramDerivedAddress({ programAddress: MARGINFI, seeds: ['vault'] }))[0]; // no key holds it

// What Otus says of a transaction you sign: what lands with someone else, and in what words.
async function said(ixs: Instruction[], before: MaybeEncodedAccount[], after: MaybeEncodedAccount[], context: Partial<Context> = {}) {
    const r = await review(transaction(ixs), { wallet: PAYER, signedBefore: 0, host: 'app.example.com', ...context }, fakeChain(before, after));
    return { payouts: r.assessment.payouts, findings: r.assessment.findings.filter((f) => f.code.startsWith('pays-')).map((f) => `${f.level}:${f.text}`) };
}

// A withdraw of 1,000 out of a lending pool's vault, signed by you, landing in a token account `to` holds.
async function withdraw(to: Address, context: Partial<Context> = {}) {
    const authority = await vaultOwner();
    const ix: Instruction = { programAddress: MARGINFI, accounts: [{ address: PAYER, role: WS }, { address: VAULT, role: W }, { address: DEST, role: W }] };
    const before = [account(PAYER, SYSTEM, SOL), tokens(VAULT, authority, 5_000n * USDC), tokens(DEST, to, 0n)];
    const after = [account(PAYER, SYSTEM, SOL - 5000n), tokens(VAULT, authority, 4_000n * USDC), tokens(DEST, to, 1_000n * USDC)];
    return said([ix], before, after, context);
}

test('funds out of a program’s custody to someone else’s wallet are said exactly, for you to judge; to yours, nothing', async () => {
    const thief = await withdraw(THIEF);
    assert.deepEqual(thief.findings, ['warn:Funds go to someone else, not to you']);
    assert.deepEqual(thief.payouts, [{ holder: THIEF, known: null, program: false, amounts: [{ asset: MINT, amount: 1_000n * USDC }], programs: [MARGINFI] }]);
    assert.deepEqual((await withdraw(PAYER)).findings, []); // a token account of yours, an ATA or not
    assert.deepEqual((await withdraw(THIEF, { wallets: [THIEF] })).findings, []); // one of your other wallets, or one you watch
    assert.deepEqual((await withdraw(THIEF, { contacts: new Map([[THIEF, 'Ana']]) })).findings, ['notice:Funds go to Ana']); // one you keep
});

test('a pool’s fee while you get the trade, a payment of yours, and rent given back are no payouts; a drain behind a payment is', async () => {
    const [pool] = await getProgramDerivedAddress({ programAddress: key(70), seeds: ['pool'] }); // its SOL, and its tokens' owner
    const fees = (await generateKeyPairSigner()).address; // the pool's fee wallet: a key someone holds
    // You sell 100 tokens into the pool: it pays you 0.98 SOL, and its fee wallet 0.02.
    const sell: Instruction = { programAddress: key(70), accounts: [{ address: PAYER, role: WS }, { address: YOURS, role: W }, { address: VAULT, role: W }, { address: pool, role: W }, { address: fees, role: W }] };
    const sold = await said(
        [sell],
        [account(PAYER, SYSTEM, SOL), tokens(YOURS, PAYER, 100n * USDC), tokens(VAULT, pool, 0n), account(pool, SYSTEM, 10n * SOL), account(fees, SYSTEM, SOL)],
        [account(PAYER, SYSTEM, SOL + (98n * SOL) / 100n - 5000n), tokens(YOURS, PAYER, 0n), tokens(VAULT, pool, 100n * USDC), account(pool, SYSTEM, 9n * SOL), account(fees, SYSTEM, SOL + (2n * SOL) / 100n)],
    );
    assert.deepEqual(sold.findings, []);
    // You pay 1 SOL: your own payment, which the balances say.
    const pay = getTransferSolInstruction({ source: createNoopSigner(PAYER), destination: THIEF, amount: SOL });
    assert.deepEqual((await said([pay], [account(PAYER, SYSTEM, 2n * SOL), account(THIEF, SYSTEM, 0n)], [account(PAYER, SYSTEM, SOL - 5000n), account(THIEF, SYSTEM, SOL)])).findings, []);
    // A program's account closed, its rent back to whoever paid it.
    const close: Instruction = { programAddress: key(70), accounts: [{ address: PAYER, role: WS }, { address: VAULT, role: W }, { address: THIEF, role: W }] };
    assert.deepEqual((await said([close], [account(PAYER, SYSTEM, SOL), account(VAULT, key(70), 2_039_280n, new Uint8Array(8)), account(THIEF, SYSTEM, SOL)], [account(PAYER, SYSTEM, SOL - 5000n), account(THIEF, SYSTEM, SOL + 2_039_280n)])).findings, []);
    // You pay the thief 10, and the vault pays it 1,000 more: those 1,000 are said.
    const authority = await vaultOwner();
    const both: Instruction = { programAddress: MARGINFI, accounts: [{ address: PAYER, role: WS }, { address: YOURS, role: W }, { address: VAULT, role: W }, { address: DEST, role: W }] };
    const hidden = await said(
        [both],
        [account(PAYER, SYSTEM, SOL), tokens(YOURS, PAYER, 10n * USDC), tokens(VAULT, authority, 5_000n * USDC), tokens(DEST, THIEF, 0n)],
        [account(PAYER, SYSTEM, SOL - 5000n), tokens(YOURS, PAYER, 0n), tokens(VAULT, authority, 4_000n * USDC), tokens(DEST, THIEF, 1_010n * USDC)],
    );
    assert.deepEqual(hidden.payouts.map((p) => [p.holder, p.amounts[0].amount]), [[THIEF, 1_000n * USDC]]);
});

test('out of a program’s custody to an account no key holds, with nothing back to you: your position or what you buy goes elsewhere; a deposit does not', async () => {
    const [nobody] = await getProgramDerivedAddress({ programAddress: key(71), seeds: ['vault'] }); // a program's address: no key holds it
    assert.deepEqual((await withdraw(nobody)).findings, ["warn:Funds go to a program's account, not to you"]);
    // A unit of something sent back to you hides nothing.
    const authority = await vaultOwner();
    const mine = (amount: bigint) => account(YOURS, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: key(44), owner: PAYER, amount }));
    const out: Instruction = { programAddress: MARGINFI, accounts: [{ address: PAYER, role: WS }, { address: VAULT, role: W }, { address: DEST, role: W }, { address: YOURS, role: W }] };
    const dust = await said(
        [out],
        [account(PAYER, SYSTEM, SOL), tokens(VAULT, authority, 5_000n * USDC), tokens(DEST, nobody, 0n), mine(0n)],
        [account(PAYER, SYSTEM, SOL - 5000n), tokens(VAULT, authority, 4_000n * USDC), tokens(DEST, nobody, 1_000n * USDC), mine(1n)],
    );
    assert.deepEqual(dust.findings, ["warn:Funds go to a program's account, not to you"]);

    // A swap through Jupiter: 100 of yours into the pool, and the 5 it buys to an account of that program's.
    const JUPITER = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
    const [pool] = await getProgramDerivedAddress({ programAddress: key(70), seeds: ['pool'] });
    const OTHER = key(44); // the token bought
    const held = (a: Address, mint: Address, owner: Address, amount: bigint) => account(a, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint, owner, amount }));
    const [poolIn, poolOut, theirs] = [key(45), key(46), key(47)];
    const swap: Instruction = { programAddress: JUPITER, accounts: [{ address: PAYER, role: WS }, { address: YOURS, role: W }, { address: poolIn, role: W }, { address: poolOut, role: W }, { address: theirs, role: W }] };
    const before = [account(PAYER, SYSTEM, SOL), held(YOURS, MINT, PAYER, 100n * USDC), held(poolIn, MINT, pool, 0n), held(poolOut, OTHER, pool, 50n), held(theirs, OTHER, nobody, 0n)];
    const after = [account(PAYER, SYSTEM, SOL - 5000n), held(YOURS, MINT, PAYER, 0n), held(poolIn, MINT, pool, 100n * USDC), held(poolOut, OTHER, pool, 45n), held(theirs, OTHER, nobody, 5n)];
    const bought = await said([swap], before, after);
    assert.deepEqual(bought.findings, ["warn:Funds go to a program's account, not to you"]);
    assert.deepEqual(bought.payouts, [{ holder: nobody, known: null, program: true, amounts: [{ asset: OTHER, amount: 5n }], programs: [JUPITER] }]);

    // A deposit: your 100 into the pool, and its receipt minted to another account of the pool's: nothing leaves anyone.
    const receipt = key(48);
    const deposit = await said([{ ...swap, accounts: [...swap.accounts!.slice(0, 3), { address: receipt, role: W }] }], [...before.slice(0, 3), held(receipt, OTHER, pool, 0n)], [...after.slice(0, 3), held(receipt, OTHER, pool, 100n)]);
    assert.deepEqual(deposit.findings, []);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getAddMemoInstruction } from '@solana-program/memo';
import {
    getAdvanceNonceAccountInstruction,
    getAllocateInstruction,
    getAssignInstruction,
    getInitializeNonceAccountInstruction,
    getTransferSolInstruction,
} from '@solana-program/system';
import {
    getApproveInstruction,
    getCloseAccountInstruction,
    getCreateAssociatedTokenIdempotentInstruction,
    getInitializeAccount3Instruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { AccountRole, address, createNoopSigner, getAddressDecoder, getAddressEncoder, type Address, type Instruction } from '@solana/kit';

import { Refused } from '../src/protocol.ts';
import type { Context } from '../src/review/assess.ts';
import { review, type Review } from '../src/review/review.ts';
import {
    account,
    ATTACKER,
    DRAIN,
    DRAIN_AFTER,
    DRAIN_BEFORE,
    EVIL_PROGRAM,
    fakeChain,
    key,
    MINT,
    PAYER,
    RECIPIENT,
    SYSTEM,
    tokenAccountData,
    transaction,
    transfer,
    USER_TOKEN,
} from './helpers.ts';

const context = (o: Partial<Context> = {}): Context => ({ wallet: PAYER, signedBefore: 0, ...o });
const problems = (r: Review) => r.assessment.findings.filter((f) => f.level !== 'ok').map((f) => `${f.level}:${f.code}`);
const signer = createNoopSigner(PAYER);
const wallet = (lamports: bigint, data?: Uint8Array) => account(PAYER, SYSTEM, lamports, data);
const tokens = (o: { delegated?: bigint } = {}, address = USER_TOKEN) => {
    const data = tokenAccountData({ mint: MINT, owner: PAYER, amount: 1000n, ...(o.delegated !== undefined && { delegate: key(70) }) });
    new DataView(data.buffer).setBigUint64(121, o.delegated ?? 0n, true);
    return account(address, TOKEN_PROGRAM_ADDRESS, 2_039_280n, data);
};

test('a plain transfer, from a known site, by programs Otus knows, is OK', async () => {
    const r = await review(transfer(), context(), fakeChain([wallet(5_000_000n)]));
    assert.equal(r.assessment.verdict, 'ok');
    assert.deepEqual(
        r.assessment.findings.map((f) => f.code),
        ['simulated', 'no-authority-change', 'normal-fee', 'all-known', 'known-site'],
    );
});

test('a drainer is danger, and your changes say why', async () => {
    const r = await review(DRAIN, context(), fakeChain(DRAIN_BEFORE, DRAIN_AFTER));
    assert.equal(r.assessment.verdict, 'danger');
    assert.deepEqual(problems(r), ['danger:wallet-change', 'danger:token-owner-change', 'warn:delegate', 'warn:large-outflow', 'warn:unknown-program']);
    assert.deepEqual(new Set(r.assessment.yours.accounts.map((c) => c.address)), new Set([PAYER, USER_TOKEN]));
});

test('your wallet turned into a nonce account, or handed to a program before it exists, is danger', async () => {
    const nonce = transaction([
        getAllocateInstruction({ newAccount: signer, space: 80n }),
        getInitializeNonceAccountInstruction({ nonceAccount: PAYER, nonceAuthority: ATTACKER }),
    ]);
    const r = await review(nonce, context(), fakeChain([wallet(5_000_000n)], [wallet(4_995_000n, new Uint8Array(80))]));
    assert.deepEqual(problems(r), ['danger:wallet-change']);

    // A relayer pays; the wallet has no account until this transaction funds it, already assigned to another program.
    const fresh = key(60);
    const gasless = transaction([
        getAssignInstruction({ account: createNoopSigner(fresh), programAddress: EVIL_PROGRAM }),
        getTransferSolInstruction({ source: signer, destination: fresh, amount: 890_880n }),
    ]);
    const g = await review(gasless, context({ wallet: fresh }), fakeChain([wallet(5_000_000n)], [account(fresh, EVIL_PROGRAM, 890_880n)]));
    assert.deepEqual(problems(g), ['danger:wallet-change']);
    assert.equal(g.assessment.yours.fee, 0n);
});

test('a durable nonce is danger, read as the runtime reads it', async () => {
    const nonce = key(40);
    const advance = getAdvanceNonceAccountInstruction({ nonceAccount: nonce, nonceAuthority: signer });
    // The nonce account signing as its own authority: valid onchain, though Kit's parser wants three accounts.
    const short = {
        programAddress: SYSTEM,
        accounts: [
            { address: nonce, role: AccountRole.WRITABLE_SIGNER },
            { address: address('SysvarRecentB1ockHashes11111111111111111111'), role: AccountRole.READONLY },
        ],
        data: new Uint8Array([4, 0, 0, 0]),
    };
    for (const ix of [advance, short]) {
        assert.deepEqual(problems(await review(transaction([ix]), context(), fakeChain([]))), ['danger:durable-nonce']);
    }
});

test('a token account of yours: a bigger allowance is a warning, a fresh one at a used address is no owner change', async () => {
    const approve = transaction([getApproveInstruction({ source: USER_TOKEN, delegate: key(70), owner: signer, amount: 2n ** 64n - 1n })]);
    const more = await review(approve, context(), fakeChain([wallet(5_000_000n), tokens({ delegated: 1n })], [wallet(4_995_000n), tokens({ delegated: 2n ** 64n - 1n })]));
    assert.deepEqual(problems(more), ['warn:delegate']);

    const ata = key(80);
    const created = tokens({}, ata);
    const funded = transaction([getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata, owner: PAYER, mint: MINT })]);
    const zeroed = transaction([getInitializeAccount3Instruction({ account: ata, mint: MINT, owner: PAYER })]);
    const r1 = await review(funded, context(), fakeChain([wallet(5_000_000n), account(ata, SYSTEM, 1_000n)], [wallet(2_960_000n), created]));
    const r2 = await review(zeroed, context(), fakeChain([wallet(5_000_000n), account(ata, TOKEN_PROGRAM_ADDRESS, 2_039_280n, new Uint8Array(165))], [wallet(4_995_000n), created]));
    assert.deepEqual([problems(r1), problems(r2)], [[], []]);
});

test('someone’s key allowed all of a token account of yours, or the close of your wrapped SOL, is critical; so is a huge fee', async () => {
    const thief = address('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'); // a key someone holds
    const allowed = (delegate: Address, delegated: bigint) => account(USER_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 1000n, delegate, delegated }));
    const said = async (delegate: Address, delegated: bigint) =>
        problems(await review(transaction([getApproveInstruction({ source: USER_TOKEN, delegate, owner: signer, amount: delegated })]), context(), fakeChain([wallet(5_000_000n), tokens()], [wallet(4_995_000n), allowed(delegate, delegated)])));
    assert.deepEqual(await said(thief, 2n ** 64n - 1n), ['danger:delegate']); // without end
    assert.deepEqual(await said(thief, 1000n), ['danger:delegate']); // all it holds
    assert.deepEqual(await said(thief, 10n), ['warn:delegate']);
    assert.deepEqual(await said(key(70), 2n ** 64n - 1n), ['warn:delegate']); // an address no key holds: a program's, as a marketplace's

    // Your wrapped SOL account's close authority given away: whoever closes it takes its 50 SOL.
    const wrapped = (closer?: Address) => account(USER_TOKEN, TOKEN_PROGRAM_ADDRESS, 50_002_039_280n, tokenAccountData({ mint: address('So11111111111111111111111111111111111111112'), owner: PAYER, amount: 50_000_000_000n, native: 2_039_280n, closer }));
    const closer = { programAddress: TOKEN_PROGRAM_ADDRESS, accounts: [{ address: USER_TOKEN, role: AccountRole.WRITABLE }, { address: PAYER, role: AccountRole.READONLY_SIGNER }], data: new Uint8Array([6, 3, 1, ...getAddressEncoder().encode(thief)]) };
    assert.deepEqual(problems(await review(transaction([closer]), context(), fakeChain([wallet(5_000_000n), wrapped()], [wallet(4_995_000n), wrapped(thief)]))), ['danger:close-authority']);

    // A fee of 0.06 SOL on a transfer of 0.001: critical, and with it nearly all of this wallet's SOL goes.
    const fee = await review(transfer(), context(), fakeChain([wallet(66_000_000n)], [wallet(66_000_000n - 1_000_000n - 60_000_000n), account(RECIPIENT, SYSTEM, 1_000_000n)], { fee: 60_000_000n }));
    assert.deepEqual(problems(fee), ['danger:high-fee', 'warn:large-outflow']);
});

test('your upgrade authority used: new code for your program, or its program data closed for good, is critical; a buffer closed is not', async () => {
    const LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');
    const [data, program, buffer] = [key(81), key(82), key(83)];
    const { WRITABLE: W, READONLY: R, READONLY_SIGNER: RS } = AccountRole;
    const loaderState = (kind: number) => account(data, LOADER, 10_000_000n, new Uint8Array([kind, 0, 0, 0, ...new Uint8Array(41)]));
    const upgrade = { programAddress: LOADER, accounts: [data, program, buffer, PAYER, key(84), key(85)].map((a, i) => ({ address: a, role: i < 4 ? W : R })).concat({ address: PAYER, role: RS }), data: new Uint8Array([3, 0, 0, 0]) };
    const close = { programAddress: LOADER, accounts: [{ address: data, role: W }, { address: PAYER, role: W }, { address: PAYER, role: RS }, { address: program, role: W }], data: new Uint8Array([5, 0, 0, 0]) };
    const codes = async (ix: Instruction, state: ReturnType<typeof loaderState>) => (await review(transaction([ix]), context(), fakeChain([wallet(5_000_000n), state]))).assessment.findings.filter((f) => f.code === 'program-change').map((f) => f.text);
    assert.deepEqual(await codes(upgrade as Instruction, loaderState(3)), ['Your program gets new code']);
    assert.deepEqual(await codes(close as Instruction, loaderState(3)), ['Your program is closed for good']);
    assert.deepEqual(await codes(close as Instruction, loaderState(1)), []); // a buffer: its rent back
});

test('your token accounts are known from the accounts themselves: an unknown program given one is a warning', async () => {
    const ix = { programAddress: EVIL_PROGRAM, accounts: [{ address: USER_TOKEN, role: AccountRole.WRITABLE }] };
    const r = await review(transaction([ix]), context(), fakeChain([wallet(5_000_000n), tokens()]));
    assert.deepEqual(problems(r), ['warn:unknown-program']);

    // Closed to someone else, it shows as yours, gone.
    const close = transaction([getCloseAccountInstruction({ account: USER_TOKEN, destination: ATTACKER, owner: signer })]);
    const c = await review(close, context(), fakeChain([wallet(5_000_000n), tokens()], [wallet(4_995_000n), account(ATTACKER, SYSTEM, 2_039_280n)]));
    assert.deepEqual(c.assessment.yours.accounts.find((x) => x.address === USER_TOKEN)?.after, null);
});

test('your address as an authority, in any account, stays where it was', async () => {
    const me = getAddressDecoder().decode(Uint8Array.from({ length: 32 }, (_, i) => i + 1)); // no repeated bytes, as real keys
    const touch = (target: Address): Instruction => ({ programAddress: SYSTEM, accounts: [{ address: target, role: AccountRole.WRITABLE }, { address: me, role: AccountRole.WRITABLE_SIGNER }] });
    const holder = key(90);
    const data = (size: number, offset: number, who: Address, head: number[] = []) => {
        const d = new Uint8Array(size);
        d.set(head);
        d.set(getAddressEncoder().encode(who), offset);
        return d;
    };
    const cases: [Address, number, number, number[], string][] = [
        [TOKEN_PROGRAM_ADDRESS, 82, 4, [1], 'danger:You would lose your mint authority'],
        [SYSTEM, 80, 8, [1, 0, 0, 0, 1], 'danger:You would lose your nonce authority'],
        [address('Stake11111111111111111111111111111111111111'), 200, 44, [1], 'danger:You would lose your withdraw authority'],
        [address('BPFLoaderUpgradeab1e11111111111111111111111'), 45, 13, [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 'danger:You would lose your program upgrade authority'],
        [EVIL_PROGRAM, 120, 40, [], 'warn:Your address would leave an account that held it, maybe as its authority'],
    ];
    for (const [program, size, offset, head, expected] of cases) {
        const before = account(holder, program, 1_000_000n, data(size, offset, me, head));
        const after = account(holder, program, 1_000_000n, data(size, offset, ATTACKER, head));
        const r = await review(transaction([touch(holder)]), context({ wallet: me }), fakeChain([before], [after]));
        const f = r.assessment.findings.filter((x) => x.code === 'authority-change').map((x) => `${x.level}:${x.text}`);
        assert.deepEqual(f, [expected]);
    }
});

test('almost all your SOL leaving is a warning; closing your own token account is not an owner change', async () => {
    const send = transaction([getTransferSolInstruction({ source: signer, destination: key(70), amount: 4_900_000n })]);
    const r = await review(send, context(), fakeChain([wallet(5_000_000n)], [wallet(95_000n), account(key(70), SYSTEM, 4_900_000n)]));
    assert.deepEqual(problems(r), ['warn:large-outflow']);

    // The RPC returns a closed account as System-owned with no lamports.
    const close = transaction([getCloseAccountInstruction({ account: USER_TOKEN, destination: PAYER, owner: signer })]);
    const empty = account(USER_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 0n }));
    const c = await review(close, context(), fakeChain([wallet(5_000_000n), empty], [wallet(7_034_280n), account(USER_TOKEN, SYSTEM, 0n)]));
    assert.deepEqual(problems(c), []);
});

test('a program Otus doesn’t know that touches nothing of yours is a notice: worth knowing, still all clear', async () => {
    assert.deepEqual(problems(await review(transaction([getAddMemoInstruction({ memo: 'hi' })]), context(), fakeChain([]))), []); // Memo it knows
    const r = await review(transaction([{ programAddress: key(30), accounts: [{ address: key(31), role: AccountRole.WRITABLE }] }]), context(), fakeChain([]));
    assert.equal(r.assessment.verdict, 'ok');
    assert.deepEqual(problems(r), ['notice:unknown-program']);
    const found = r.assessment.findings.find((f) => f.code === 'unknown-program')!;
    assert.deepEqual([found.text, found.note], [`${key(30).slice(0, 4)}…${key(30).slice(-4)} is not a program Otus knows`, 'It touches nothing of yours']);
});

test('an unknown program that gets your signature is a warning: what it does decides the rest', async () => {
    const ix = { programAddress: key(30), accounts: [{ address: PAYER, role: AccountRole.WRITABLE_SIGNER }] };
    const r = await review(transaction([ix]), context(), fakeChain([]));
    assert.deepEqual(problems(r), ['warn:unknown-program']);
});

test('a failed simulation is danger: a site can make it fail to hide what it does', async () => {
    const chain = fakeChain([], [], { fee: 6_000_000n, error: { InstructionError: [0, { Custom: 1 }] } });
    const r = await review(transfer(), context({ signedBefore: null }), chain);
    assert.equal(r.assessment.verdict, 'danger');
    assert.deepEqual(problems(r), ['danger:simulation-failed', 'warn:high-fee', 'warn:first-visit']);
});

test('refuses a transaction this wallet does not sign', async () => {
    await assert.rejects(review(transfer(), context({ wallet: key(50) }), fakeChain([])), Refused);
});

test('your own transfer to a program’s account is warned about; to a wallet, it is not', async () => {
    const own = (owner: Address) => review(transfer(), context({ own: true, to: RECIPIENT }), fakeChain([wallet(5_000_000n), account(RECIPIENT, owner, 1_000_000n)]));
    assert.ok(!(await own(SYSTEM)).assessment.findings.some((f) => f.code === 'to-program'));
    const toProgram = await own(EVIL_PROGRAM);
    assert.deepEqual(problems(toProgram), ['warn:to-program']);
    assert.equal(toProgram.assessment.verdict, 'warn');
});

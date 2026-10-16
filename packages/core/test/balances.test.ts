import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getTransferSolInstruction } from '@solana-program/system';
import { getCloseAccountInstruction, getSyncNativeInstruction, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { AccountRole, address, createNoopSigner, getAddressEncoder, getProgramDerivedAddress, getU32Encoder, getU64Encoder, type Address, type Instruction, type MaybeEncodedAccount } from '@solana/kit';

import { TOKEN_2022_PROGRAM_ADDRESS } from '@otus-wallet/sdk/programs/core';
import { review } from '@otus-wallet/sdk/review/review';
import { prepare } from '@otus-wallet/sdk/prepare/prepare';
import type { TokenInfo } from '../src/tokens.ts';
import { describe, siteView } from '../src/view.ts';
import { golden } from './golden.ts';
import { account, ATTACKER, fakeChain, key, PAYER, SYSTEM, tokenAccountData, transaction } from './helpers.ts';

const views: unknown[] = []; // every view these tests make, in order: compared whole at the end

// What the approval window would show, for a site you first signed for long ago unless told otherwise.
async function shown(instructions: Instruction[], before: MaybeEncodedAccount[], after: MaybeEncodedAccount[], o: { tokens?: Map<string, TokenInfo | null>; decimals?: Map<string, number>; signedBefore?: number | null } = {}) {
    const chain = fakeChain(before, after);
    const r = await review(transaction(instructions), { wallet: PAYER, signedBefore: o.signedBefore === undefined ? 0 : o.signedBefore, host: 'app.example.com' }, chain);
    const p = await prepare(r, PAYER, chain);
    const site = siteView('https://app.example.com', { account: PAYER, signatures: 3 });
    const view = describe(r, p, { site, account: { label: 'Me', address: PAYER }, signer: 'ready', cluster: 'solana:mainnet', known: { tokens: o.tokens ?? new Map(), decimals: o.decimals ?? new Map() } });
    views.push(view);
    const codes = view.findings.filter((f) => f.tone !== 'ok').map((f) => `${f.tone}:${f.title}`);
    return { r, p, view, codes, rows: view.balances.flatMap((b) => b.lines.map((l) => `${b.asset} ${l.amount} ${l.note}`)) };
}

const me = createNoopSigner(PAYER);
const THIEF = address('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'); // a key someone holds: on the curve
const WSOL = address('So11111111111111111111111111111111111111112');
const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SOL = 1_000_000_000n;
const FEE = 5_000n;
const RENT = 2_039_280n;

test('an account with your address in it is not yours: what goes there leaves you, and it is still guarded', async () => {
    // A token multisig, 1 of [attacker, you]: the attacker alone can move what it holds.
    const multisig = key(31);
    const data = new Uint8Array(355);
    data.set([1, 2, 1]);
    data.set(getAddressEncoder().encode(ATTACKER), 3);
    data.set(getAddressEncoder().encode(PAYER), 35);
    const { r, p, codes, rows } = await shown(
        [getTransferSolInstruction({ source: me, destination: multisig, amount: 49n * SOL / 10n })],
        [account(PAYER, SYSTEM, 5n * SOL), account(multisig, TOKEN_2022_PROGRAM_ADDRESS, 3_382_560n, data)],
        [account(PAYER, SYSTEM, 5n * SOL - 49n * SOL / 10n - FEE), account(multisig, TOKEN_2022_PROGRAM_ADDRESS, 3_382_560n + 49n * SOL / 10n, data)],
    );
    assert.deepEqual(r.assessment.yours.accounts.map((c) => c.address), [PAYER]);
    assert.deepEqual(r.assessment.keyed.map((c) => c.address), [multisig]);
    assert.match(rows[0], /^SOL −4\.9 To \S+ \(program\)$/);
    assert.ok(codes.includes('warn:You send almost all your SOL'), codes.join());
    assert.ok(p.holds.some((h) => h.kind === 'account' && h.account === multisig && h.keys.includes(35)));
});

test('wrapping your own SOL is no gain, and SOL sent alongside shows where it goes, never "Swapped"', async () => {
    const wsol = key(32);
    const { r, rows, view } = await shown(
        [getTransferSolInstruction({ source: me, destination: wsol, amount: SOL }), getSyncNativeInstruction({ account: wsol }), getTransferSolInstruction({ source: me, destination: THIEF, amount: 6n * SOL })],
        [account(PAYER, SYSTEM, 10n * SOL), account(wsol, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: WSOL, owner: PAYER, amount: 0n, native: RENT })), account(THIEF, SYSTEM, SOL)],
        [account(PAYER, SYSTEM, 3n * SOL - FEE), account(wsol, TOKEN_PROGRAM_ADDRESS, RENT + SOL, tokenAccountData({ mint: WSOL, owner: PAYER, amount: SOL, native: RENT })), account(THIEF, SYSTEM, 7n * SOL)],
    );
    assert.deepEqual(r.assessment.flows.map((f) => [f.asset, f.change]), [['SOL', -6n * SOL]]);
    assert.deepEqual(rows, [`SOL −7 To ${THIEF} +1`, 'SOL −0.000005 Network fee', 'wSOL +1 Wrapped from wallet']);
    assert.ok(!view.balances.some((b) => b.lines.some((l) => /Via/.test(l.note))));
});

test('a token that is not verified goes by its address, is never "guaranteed", and is told apart when it imitates one', async () => {
    const fake = key(33);
    const [mine, theirs, myUsdc, theirUsdc] = [key(34), key(35), key(36), key(37)];
    const tokens = new Map<string, TokenInfo>([
        [fake, { id: fake, name: 'USD Coin', symbol: 'USDC', icon: null, verified: false, usdPrice: 1, change24h: 0, decimals: 6 }],
        [USDC, { id: USDC, name: 'USD Coin', symbol: 'USDC', icon: null, verified: true, usdPrice: 1, change24h: 0, decimals: 6 }],
    ]);
    const { rows, codes, view } = await shown(
        [
            getTransferCheckedInstruction({ source: theirs, mint: fake, destination: mine, authority: me, amount: 900_000_000n, decimals: 6 }),
            getTransferCheckedInstruction({ source: myUsdc, mint: USDC, destination: theirUsdc, authority: me, amount: 900_000_000n, decimals: 6 }),
        ],
        [
            account(PAYER, SYSTEM, SOL),
            account(mine, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: fake, owner: PAYER, amount: 0n })),
            account(theirs, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: fake, owner: THIEF, amount: 900_000_000n, delegate: PAYER })),
            account(myUsdc, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: PAYER, amount: 1_800_000_000n })),
            account(theirUsdc, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: THIEF, amount: 0n })),
        ],
        [
            account(PAYER, SYSTEM, SOL - FEE),
            account(mine, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: fake, owner: PAYER, amount: 900_000_000n })),
            account(theirs, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: fake, owner: THIEF, amount: 0n })),
            account(myUsdc, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: PAYER, amount: 900_000_000n })),
            account(theirUsdc, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: THIEF, amount: 900_000_000n })),
        ],
        { tokens },
    );
    assert.ok(rows.includes(`${fake} +900 Unverified · ≥ 810`), rows.join('\n')); // whole: the window cuts it short
    assert.ok(rows.includes(`USDC −900 To ${THIEF}`), rows.join('\n'));
    assert.deepEqual(view.balances.filter((b) => b.asset === 'USDC').map((b) => b.verified), [true]);
    assert.ok(codes.includes('warn:A token calls itself USDC, and it is not the real one'), codes.join());
});

test('a wallet whose address starts with "Sysvar" is a wallet', async () => {
    const vanity = address('SysvarC1ock111111111111111111111111113JRtQt');
    const { r, rows } = await shown([getTransferSolInstruction({ source: me, destination: vanity, amount: 3n * SOL })], [account(PAYER, SYSTEM, 10n * SOL)], [account(PAYER, SYSTEM, 7n * SOL - FEE), account(vanity, SYSTEM, 3n * SOL)]);
    assert.equal(rows[0], `SOL −3 To ${vanity}`); // no "(program)": a wallet
    assert.equal(r.assessment.kinds.get(vanity), 'new');
});

test('rent comes back only when it does: a token account closed to you, and wrapped SOL closed to someone else', async () => {
    const [usdc, wsol] = [key(38), key(39)];
    const toMe = await shown(
        [getCloseAccountInstruction({ account: usdc, destination: PAYER, owner: me })],
        [account(PAYER, SYSTEM, SOL), account(usdc, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: PAYER, amount: 0n }))],
        [account(PAYER, SYSTEM, SOL + RENT - FEE)],
        { tokens: new Map([[USDC, { id: USDC, name: 'USD Coin', symbol: 'USDC', icon: null, verified: true, usdPrice: 1, change24h: 0, decimals: 6 }]]) },
    );
    assert.deepEqual(toMe.rows, ['SOL +0.00203928 Rent back', 'SOL −0.000005 Network fee']);
    const away = await shown(
        [getCloseAccountInstruction({ account: wsol, destination: THIEF, owner: me })],
        [account(PAYER, SYSTEM, SOL), account(wsol, TOKEN_PROGRAM_ADDRESS, 10n * SOL + RENT, tokenAccountData({ mint: WSOL, owner: PAYER, amount: 10n * SOL, native: RENT })), account(THIEF, SYSTEM, SOL)],
        [account(PAYER, SYSTEM, SOL - FEE), account(THIEF, SYSTEM, 11n * SOL + RENT)],
    );
    assert.deepEqual(away.rows, [`wSOL −10.00203928 To ${THIEF}`, 'SOL −0.000005 Network fee']);
    assert.ok(away.codes.includes('warn:You send almost all your SOL'), away.codes.join());
});

test('a swap: rent for your new token account on its own row, what goes out "Via" the program, what comes in held', async () => {
    const RAYDIUM = address('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    const [pool] = await getProgramDerivedAddress({ programAddress: RAYDIUM, seeds: ['pool'] });
    const [solVault, usdcVault, myUsdc] = [key(40), key(41), key(42)];
    const usdc = new Map([[USDC, { id: USDC, name: 'USD Coin', symbol: 'USDC', icon: null, verified: true, usdPrice: 1, change24h: 0, decimals: 6 }]]);
    const swap: Instruction = {
        programAddress: RAYDIUM,
        accounts: [
            { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
            { address: myUsdc, role: AccountRole.WRITABLE },
            { address: solVault, role: AccountRole.WRITABLE },
            { address: usdcVault, role: AccountRole.WRITABLE },
        ],
        data: new Uint8Array([9]),
    };
    const { rows, codes } = await shown(
        [swap],
        [
            account(PAYER, SYSTEM, 10n * SOL),
            account(solVault, TOKEN_PROGRAM_ADDRESS, 50n * SOL, tokenAccountData({ mint: WSOL, owner: pool, amount: 50n * SOL - RENT, native: RENT })),
            account(usdcVault, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: pool, amount: 10_000_000_000n })),
            account(RAYDIUM, address('BPFLoaderUpgradeab1e11111111111111111111111'), 1n),
        ],
        [
            account(PAYER, SYSTEM, 10n * SOL - 3n * SOL / 2n - RENT - FEE),
            account(myUsdc, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: PAYER, amount: 271_384_112n })),
            account(solVault, TOKEN_PROGRAM_ADDRESS, 50n * SOL + 3n * SOL / 2n, tokenAccountData({ mint: WSOL, owner: pool, amount: 50n * SOL + 3n * SOL / 2n - RENT, native: RENT })),
            account(usdcVault, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: pool, amount: 10_000_000_000n - 271_384_112n })),
        ],
        { tokens: usdc },
    );
    // What comes in may land a tenth below the simulation, as prices move in a trade.
    assert.deepEqual(rows, ['SOL −1.5 Via Raydium AMM', 'SOL −0.00203928 Rent for new account', 'SOL −0.000005 Network fee', 'USDC +271.384112 ≥ 244.2457 guaranteed']);
    assert.ok(!codes.some((c) => c.startsWith('danger')), codes.join());
});

test('your stake’s SOL to a wallet: a warning through a program Otus can’t read; read in words, a stake withdraw is told', async () => {
    const STAKE = address('Stake11111111111111111111111111111111111111');
    const stake = key(43);
    const meta = new Uint8Array(200);
    meta.set(getU32Encoder().encode(1));
    meta.set(getAddressEncoder().encode(PAYER), 12);
    meta.set(getAddressEncoder().encode(PAYER), 44);
    const withdraw: Instruction = {
        programAddress: STAKE,
        accounts: [
            { address: stake, role: AccountRole.WRITABLE },
            { address: THIEF, role: AccountRole.WRITABLE },
            { address: address('SysvarC1ock11111111111111111111111111111111'), role: AccountRole.READONLY },
            { address: address('SysvarStakeHistory1111111111111111111111111'), role: AccountRole.READONLY },
            { address: PAYER, role: AccountRole.READONLY_SIGNER },
        ],
        data: new Uint8Array([...getU32Encoder().encode(4), ...getU64Encoder().encode(50n * SOL)]),
    };
    const before = [account(PAYER, SYSTEM, SOL), account(stake, STAKE, 50n * SOL, meta), account(THIEF, SYSTEM, SOL)];
    const after = [account(PAYER, SYSTEM, SOL - FEE), account(THIEF, SYSTEM, 51n * SOL)];
    // The same accounts through a program Otus can't read: told, as a warning.
    const blind = await shown([{ ...withdraw, programAddress: key(44) }], before, after);
    assert.ok(blind.codes.includes('warn:An asset of yours goes to someone else'), blind.codes.join());
    // The stake program's own Withdraw, read in words: where it goes is said, as a transfer's is.
    const { codes, rows, view } = await shown([withdraw], before, after);
    assert.ok(!codes.includes('danger:An asset of yours goes to someone else'), codes.join());
    assert.match(rows[0], /^Staked SOL −50/);
    const effect = view.programs.find((p) => p.address === STAKE)?.instructions[0];
    assert.deepEqual([effect?.name, effect?.effects[0].text], ['Withdraw', `50 SOL from your stake account ${stake} to ${THIEF}`]);
});

test('what leaves you shows where it ends: a stake set up by no one, SOL in a token account someone else closes', async () => {
    const STAKE = address('Stake11111111111111111111111111111111111111');
    const stake = key(43);
    const meta = (kind: number) => {
        const d = new Uint8Array(200);
        d.set(getU32Encoder().encode(2));
        d.set(getAddressEncoder().encode(PAYER), 12);
        d.set(getAddressEncoder().encode(PAYER), 44);
        d.set(getU32Encoder().encode(kind));
        return d;
    };
    // Withdrawn in full, which leaves it set up by no one, then 100 SOL in: anyone may set it up and take them.
    const withdraw: Instruction = {
        programAddress: STAKE,
        accounts: [
            { address: stake, role: AccountRole.WRITABLE },
            { address: PAYER, role: AccountRole.WRITABLE },
            { address: address('SysvarC1ock11111111111111111111111111111111'), role: AccountRole.READONLY },
            { address: address('SysvarStakeHistory1111111111111111111111111'), role: AccountRole.READONLY },
            { address: PAYER, role: AccountRole.READONLY_SIGNER },
        ],
        data: new Uint8Array([...getU32Encoder().encode(4), ...getU64Encoder().encode(2n * SOL)]),
    };
    const into = getTransferSolInstruction({ source: me, destination: stake, amount: 100n * SOL });
    const left = await shown([withdraw, into], [account(PAYER, SYSTEM, 1000n * SOL), account(stake, STAKE, 2n * SOL, meta(2))], [account(PAYER, SYSTEM, 902n * SOL - FEE), account(stake, STAKE, 100n * SOL, meta(0))]);
    assert.deepEqual(left.rows, ['SOL −98 To an account no one owns', 'SOL −0.000005 Network fee', 'Staked SOL −2 Anyone can take it']);
    // Your token account, its close authority someone else's: SOL sent into it is theirs to take.
    const T = key(46);
    const held = (extra: bigint) => account(T, TOKEN_PROGRAM_ADDRESS, RENT + extra, tokenAccountData({ mint: USDC, owner: PAYER, amount: 0n, closer: THIEF }));
    const closable = await shown([getTransferSolInstruction({ source: me, destination: T, amount: 100n * SOL })], [account(PAYER, SYSTEM, 1000n * SOL), held(0n)], [account(PAYER, SYSTEM, 900n * SOL - FEE), held(100n * SOL)]);
    assert.equal(closable.rows[0], `SOL −100 To ${THIEF}`);
});

test('a site is known a day after the first transaction you signed for it', async () => {
    const now = Math.floor(Date.now() / 1000);
    const pay = [getTransferSolInstruction({ source: me, destination: THIEF, amount: SOL })];
    const [before, after] = [[account(PAYER, SYSTEM, 10n * SOL)], [account(PAYER, SYSTEM, 9n * SOL - FEE), account(THIEF, SYSTEM, SOL)]];
    const site = async (signedBefore: number | null) => (await shown(pay, before, after, { signedBefore })).view.findings.find((f) => /site/.test(f.title));
    assert.deepEqual([(await site(null))?.tone, (await site(now - 3_600))?.tone, (await site(now - 3 * 86_400))?.tone], ['warn', 'notice', 'ok']);
});

test('each asset shows what it comes to, its lines under it', async () => {
    const { view } = await shown(
        [getTransferSolInstruction({ source: me, destination: THIEF, amount: SOL })],
        [account(PAYER, SYSTEM, 5n * SOL)],
        [account(PAYER, SYSTEM, 4n * SOL - FEE), account(THIEF, SYSTEM, SOL)],
    );
    assert.deepEqual(view.balances.map((b) => [b.asset, b.amount, b.lines.length]), [['SOL', '−1.000005', 2]]);
});

// Last: every view above, whole, as it was when this was written. A change to what the window shows fails here.
test('every view these tests make is the one kept', () => golden('balances-views', views));

test('a mint read with other decimals than the token list gives: its amounts may be wrong, and that is said', async () => {
    const [mine, theirs] = [key(36), key(37)];
    const tokens = new Map<string, TokenInfo>([[USDC, { id: USDC, name: 'USD Coin', symbol: 'USDC', icon: null, verified: true, usdPrice: 1, change24h: 0, decimals: 6 }]]);
    const pay = [getTransferCheckedInstruction({ source: mine, mint: USDC, destination: theirs, authority: me, amount: 1_000_000_000n, decimals: 6 })];
    const before = [account(PAYER, SYSTEM, SOL), account(mine, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: PAYER, amount: 2_000_000_000n })), account(theirs, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: THIEF, amount: 0n }))];
    const after = [account(PAYER, SYSTEM, SOL - FEE), account(mine, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: PAYER, amount: 1_000_000_000n })), account(theirs, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: THIEF, amount: 1_000_000_000n }))];
    const lied = await shown(pay, before, after, { tokens, decimals: new Map([[USDC, 9]]) });
    assert.ok(lied.codes.includes("warn:A token's amounts may be wrong"), lied.codes.join());
    const told = await shown(pay, before, after, { tokens, decimals: new Map([[USDC, 6]]) });
    assert.ok(!told.codes.some((c) => c.includes('may be wrong')));
});

test('a line names who takes most of it: a tip beside a payment to a program is the "+1"', async () => {
    const PROGRAM = address('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
    const [vault] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ['vault'] });
    const tip = 10_000n;
    const { rows } = await shown(
        [getTransferSolInstruction({ source: me, destination: vault, amount: 5n * SOL }), getTransferSolInstruction({ source: me, destination: THIEF, amount: tip })],
        [account(PAYER, SYSTEM, 10n * SOL), account(vault, PROGRAM, SOL), account(THIEF, SYSTEM, SOL)],
        [account(PAYER, SYSTEM, 5n * SOL - tip - FEE), account(vault, PROGRAM, 6n * SOL), account(THIEF, SYSTEM, SOL + tip)],
    );
    assert.equal(rows[0], `SOL −5.00001 To ${vault} (program) +1`);
});

test('tokens going out to no account read here never read as staying yours', async () => {
    const [mine, vault, pool] = [key(44), key(45), key(46)];
    const usdc = new Map([[USDC, { id: USDC, name: 'USD Coin', symbol: 'USDC', icon: null, verified: true, usdPrice: 1, change24h: 0, decimals: 6 }]]);
    const { rows } = await shown(
        [getTransferCheckedInstruction({ source: mine, mint: USDC, destination: vault, authority: me, amount: 1_000_000n, decimals: 6 })],
        [account(PAYER, SYSTEM, SOL), account(mine, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: PAYER, amount: 5_000_000n })), account(vault, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: pool, amount: 100_000_000n }))],
        // The busy vault read a slot before the simulation: others took more out of it than this puts in.
        [account(PAYER, SYSTEM, SOL - FEE), account(mine, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: PAYER, amount: 4_000_000n })), account(vault, TOKEN_PROGRAM_ADDRESS, RENT, tokenAccountData({ mint: USDC, owner: pool, amount: 58_000_000n }))],
        { tokens: usdc },
    );
    assert.ok(rows.includes('USDC −1 Leaves your account'), rows.join(' | '));
});

test('your wallet in a balance note is its address, tagged yours, never a bare "you"', async () => {
    const wsol = key(47);
    const { rows } = await shown(
        [getCloseAccountInstruction({ account: wsol, destination: PAYER, owner: me })],
        [account(PAYER, SYSTEM, SOL), account(wsol, TOKEN_PROGRAM_ADDRESS, 10n * SOL + RENT, tokenAccountData({ mint: WSOL, owner: PAYER, amount: 10n * SOL, native: RENT }))],
        [account(PAYER, SYSTEM, 11n * SOL + RENT - FEE)],
    );
    assert.ok(rows.includes(`wSOL −10.00203928 To ${PAYER} (you)`), rows.join(' | '));
});

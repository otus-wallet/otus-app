import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getTransferSolInstruction } from '@solana-program/system';
import { AuthorityType, getSetAuthorityInstruction, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { AccountRole, address, createNoopSigner, getAddressEncoder, getU32Encoder, getU64Encoder, type Address } from '@solana/kit';

import { CORE_PLUGINS } from '../src/programs/core.ts';
import { ago, assess, ranked, type Context } from '../src/review/assess.ts';
import { story, type Names } from '../src/review/effects.ts';
import type { Explained } from '../src/review/explain.ts';
import { deployments } from '../src/review/programs.ts';
import { resolve } from '../src/review/resolve.ts';
import { review } from '../src/review/review.ts';
import { decode } from '../src/review/decode.ts';
import { lookalike } from '../src/review/sites.ts';
import { account, ATTACKER, EVIL_PROGRAM, fakeChain, key, MINT, PAYER, SYSTEM, tokenAccountData, transaction, USER_TOKEN } from './helpers.ts';

const THIEF = address('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'); // a key someone holds: on the curve
const THIEF_TOKEN = key(24);
const context = (o: Partial<Context> = {}): Context => ({ wallet: PAYER, signedBefore: 0, ...o });

test('tells a site that imitates a known one', () => {
    const host = (name: string) => new URL(`https://${name}`).host; // as the browser reports it: "xn--" for other letters
    const cases: [string, string | null][] = [
        ['jup.ag', null], ['app.jup.ag', null], ['jup.ag:8443', null], ['jup-claim.app', 'jup.ag'], ['raydiurn.io', 'raydium.io'],
        // Sites that moved, or have more than one: each is known (kamino.finance goes to kamino.com).
        ['kamino.com', null], ['app.kamino.com', null], ['kamino.finance', null], ['backpack.exchange', null], ['kamino-claim.com', 'kamino.finance'],
        ['phantom-wallet.com', 'phantom.app'], ['pumpfun.lol', 'pump.fun'], ['example.com', null], ['localhost:8765', null],
        // Words glued on, letters that pass for others, free subdomains, two-level country domains.
        ['jupiterswap.com', 'jup.ag'], ['claimjup.io', 'jup.ag'], ['phantomwallet.app', 'phantom.app'], ['raydiumswap.io', 'raydium.io'],
        ['raydiurn-app.com', 'raydium.io'], ['raydlum.vercel.app', 'raydium.io'], ['raydiurn.pages.dev', 'raydium.io'], ['raydiun.co.uk', 'raydium.io'],
        ['jito-airdrop.com', 'jito.network'], ['zeta-claim.io', 'zeta.markets'], ['magic-eden.io', 'magiceden.io'], ['jup.ag.claim-now.com', 'jup.ag'],
        // Other alphabets, as the browser sends them.
        [host('jüp.ag'), 'jup.ag'], [host('раydium.io'), 'raydium.io'], [host('phаntom.app'), 'phantom.app'],
        // Plain words and other brands stay what they are.
        ['draft.com', null], ['parcel.com', null], ['jupyter.org', null], ['tensorflow.org', null], ['solanabeach.io', null], ['crypto-exchange.com', null],
    ];
    for (const [name, like] of cases) assert.equal(lookalike(name), like, name);
    assert.match(host('раydium.io'), /^xn--/);
});

test('a notice is worth knowing and leaves the verdict as it was', () => {
    assert.equal(ranked([{ level: 'notice', code: 'x', text: '' }, { level: 'ok', code: 'y', text: '' }]).verdict, 'ok');
    assert.equal(ranked([{ level: 'notice', code: 'x', text: '' }, { level: 'warn', code: 'y', text: '' }]).verdict, 'warn');
    assert.deepEqual([ago(30), ago(7_200), ago(3 * 86_400)], ['1 minute ago', '2 hours ago', '3 days ago']);
});

// A drainer: an unknown program, deployed two hours ago, moves your tokens to a thief's token account.
const DRAIN = transaction([
    {
        programAddress: EVIL_PROGRAM,
        accounts: [
            { address: PAYER, role: AccountRole.WRITABLE_SIGNER },
            { address: USER_TOKEN, role: AccountRole.WRITABLE },
            { address: THIEF_TOKEN, role: AccountRole.WRITABLE },
        ],
        data: new Uint8Array([7, 7]),
    },
]);
const BEFORE = [
    account(PAYER, SYSTEM, 5_000_000n),
    account(USER_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 1_000n })),
    account(THIEF_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: THIEF, amount: 0n })),
];
const AFTER = [
    account(PAYER, SYSTEM, 4_995_000n),
    account(USER_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: PAYER, amount: 0n })),
    account(THIEF_TOKEN, TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: MINT, owner: THIEF, amount: 1_000n })),
];

test('a drainer: where your tokens go, what each account is, and a program deployed hours ago', async () => {
    const now = 1_800_000_000;
    const deployed = new Map([[EVIL_PROGRAM, { deployed: now - 7_200, upgradeable: true, builtin: false }]]);
    const chain = fakeChain(BEFORE, AFTER);
    const r = await review(DRAIN, context({ now }), { ...chain, heads: async () => [], blockTime: async () => null });
    const { flows, kinds, findings } = r.assessment;
    assert.deepEqual(flows, [{ asset: MINT, change: -1_000n, others: [{ address: THIEF_TOKEN, holder: THIEF, amount: 1_000n, wallet: true }] }]);
    assert.deepEqual([kinds.get(PAYER), kinds.get(USER_TOKEN), kinds.get(THIEF_TOKEN), kinds.get(EVIL_PROGRAM)], ['you', 'your-tokens', 'tokens', 'new']);
    const codes = findings.filter((f) => f.level !== 'ok').map((f) => `${f.level}:${f.code}`);
    assert.ok(codes.includes('danger:sends-to-wallet') && codes.includes('warn:unknown-program'), codes.join());
    // Deployed two hours ago, as the deployments step finds it, an unknown program that gets you is danger.
    const assessed = assess(r, r.changes, r.explained, context({ now, deployments: deployed }));
    assert.deepEqual(assessed.findings.find((f) => f.code === 'fresh-program'), { level: 'danger', code: 'fresh-program', text: 'An unknown program was deployed 2 hours ago', note: 'Its authority can still change it', subject: EVIL_PROGRAM });
});

test('reads when an upgradeable program was deployed, from its program data account', async () => {
    const programData = key(41);
    const program = account(EVIL_PROGRAM, address('BPFLoaderUpgradeab1e11111111111111111111111'), 1_141_440n, new Uint8Array([...getU32Encoder().encode(2), ...getAddressEncoder().encode(programData)]));
    const head = new Uint8Array([...getU32Encoder().encode(3), ...getU64Encoder().encode(123_456n), 1, ...getAddressEncoder().encode(ATTACKER)]);
    const chain = {
        ...fakeChain([{ ...program, executable: true } as typeof program]),
        heads: async (addresses: readonly Address[]) => addresses.map((a) => ({ ...account(a, address('BPFLoaderUpgradeab1e11111111111111111111111'), 1n, head) })),
        blockTime: async (slot: bigint) => (slot === 123_456n ? 1_700_000_000 : null),
    };
    const resolved = await resolve(await decode(DRAIN), chain);
    assert.deepEqual(await deployments(resolved, chain), new Map([[EVIL_PROGRAM, { deployed: 1_700_000_000, upgradeable: true, builtin: false }]]));
});

// What each instruction says, given how the transaction's accounts read.
const names: Names = {
    wallet: PAYER,
    who: (a) => (a === PAYER ? 'you' : a === USER_TOKEN ? 'your USDC account' : a === THIEF ? 'HAgk…Kpqk' : `acct ${a.slice(0, 4)}`),
    mine: (a) => a === PAYER || a === USER_TOKEN,
    existed: () => true,
    mintOf: () => MINT,
    token: () => ({ symbol: 'USDC', decimals: 6, verified: true }),
    program: (a) => a,
    priorityFee: 66_000n,
    payer: PAYER,
    changes: (a) => (a === USER_TOKEN ? ['−0.001 USDC from your USDC account'] : []),
};
const explained = async (ix: Parameters<typeof transaction>[0][number]): Promise<Explained> => {
    const plugin = CORE_PLUGINS.find((p) => p.program === ix.programAddress);
    const e = plugin?.explain({ ...ix, accounts: ix.accounts ?? [], data: ix.data ?? new Uint8Array() } as never);
    return { program: ix.programAddress, programName: plugin?.name ?? null, source: e ? 'plugin' : 'unknown', data: ix.data ?? new Uint8Array(), ...(e ?? { name: 'Unknown instruction', accounts: (ix.accounts ?? []).map((m, i) => ({ role: `account ${i + 1}`, address: m.address })), args: [] }) };
};

test('tells what an instruction does, in words', async () => {
    const me = createNoopSigner(PAYER);
    const sol = story(await explained(getTransferSolInstruction({ source: me, destination: THIEF, amount: 1_500_000_000n })), names);
    assert.deepEqual(sol, { args: '1.5 SOL → HAgk…Kpqk', effects: [{ text: '1.5 SOL from you to HAgk…Kpqk', tone: 'plain' }] });
    const usdc = story(await explained(getTransferCheckedInstruction({ source: USER_TOKEN, mint: MINT, destination: THIEF_TOKEN, authority: me, amount: 2_140_550_000n, decimals: 6 })), names);
    assert.equal(usdc.effects[0].text, `2,140.55 USDC from your USDC account to acct ${THIEF_TOKEN.slice(0, 4)}`);
    const owner = story(await explained(getSetAuthorityInstruction({ owned: USER_TOKEN, owner: me, authorityType: AuthorityType.AccountOwner, newAuthority: THIEF })), names, true);
    assert.deepEqual(owner.effects, [{ text: 'The ownership of your USDC account goes to HAgk…Kpqk', tone: 'danger' }]);
    const blind = story({ program: EVIL_PROGRAM, programName: null, source: 'unknown', data: new Uint8Array([111, 42, 145, 0, 9]), name: 'Unknown instruction', accounts: [{ role: 'account 1', address: USER_TOKEN }], args: [] }, names, true);
    assert.deepEqual(blind, { args: 'No plugin reads it · data 0x6f2a9100… · 5 bytes', effects: [{ text: '−0.001 USDC from your USDC account', tone: 'danger' }] });
});

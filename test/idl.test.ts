import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deflateSync, gzipSync } from 'node:zlib';

import { AccountRole, createNoopSigner, getAddressEncoder, type Address, type MaybeEncodedAccount } from '@solana/kit';

import type { Simulation } from '../src/chain.ts';
import { getTransferSolInstruction } from '@solana-program/system';

import { tellWith } from '../src/idl/explain.ts';
import { idlAddresses, PROGRAM_METADATA, readIdl, type Idl, type Source } from '../src/idl/read.ts';
import { review } from '../src/review/review.ts';
import { prepare } from '../src/send/prepare.ts';
import { describe, siteView } from '../src/ui/view.ts';
import { account, fakeChain, key, PAYER, SYSTEM, transaction } from './helpers.ts';

const DIR = new URL('./idl/', import.meta.url);
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' as Address;
const CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' as Address;
const MOONSHOT = 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG' as Address;
const SOME = key(30);
const ANCHOR_IDL = [24, 70, 98, 191, 58, 144, 123, 158];

type Fixture = { address: Address; owner: Address; data: string };
const fixture = (program: Address, from: Source): Fixture => JSON.parse(readFileSync(new URL(`${program}.${from}.json`, DIR), 'utf8'));
const samples: { program: Address; data: string; accounts: Address[] }[] = JSON.parse(readFileSync(new URL('instructions.json', DIR), 'utf8'));
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
const stored = (owner: Address, data: Uint8Array): MaybeEncodedAccount => ({ exists: true, address: key(99), programAddress: owner, data, executable: false, lamports: 1n as never, space: BigInt(data.length) });
const idlOf = async (program: Address, from: Source) => readIdl(stored(fixture(program, from).owner, bytes(fixture(program, from).data)), from, program);
const sample = (program: Address, n = 0) => samples.filter((s) => s.program === program)[n];
const told = (idls: Idl[], s: { data: string; accounts: Address[] }) => tellWith(idls, bytes(s.data), s.accounts);

// Anchor's IDL account around an IDL's text, as `anchor idl init` writes it.
function anchorAccount(program: Address, text: string | Uint8Array, compress = (b: Uint8Array) => deflateSync(b)): MaybeEncodedAccount {
    const zipped = compress(typeof text === 'string' ? new TextEncoder().encode(text) : text);
    const data = new Uint8Array(44 + zipped.length);
    data.set(ANCHOR_IDL, 0);
    new DataView(data.buffer).setUint32(40, zipped.length, true);
    data.set(zipped, 44);
    return stored(program, data);
}

// An Anchor IDL (spec 0.1.0) of one instruction, discriminator 1..8, with these arguments and defined types.
const anchorIdl = (args: unknown[], types: unknown[] = [], name = 'boom') =>
    JSON.stringify({ address: SOME, metadata: { name: 'evil', version: '0.1.0', spec: '0.1.0' }, instructions: [{ name, discriminator: [1, 2, 3, 4, 5, 6, 7, 8], accounts: [{ name: 'user', writable: true, signer: true }], args }], types });
const data = (...rest: number[]) => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, ...rest]);

test('finds where a program publishes its IDL, both places, as mainnet has them', async () => {
    for (const [program, from] of [[JUPITER, 'anchor'], [CLMM, 'metadata'], [MOONSHOT, 'anchor']] as const) assert.equal((await idlAddresses(program))[from], fixture(program, from).address);
});

test('reads IDLs as programs publish them: Anchor’s account (either spec) and the canonical metadata', async () => {
    const read = async (program: Address, from: Source) => {
        const idl = await idlOf(program, from);
        return idl && [idl.root.program.name, idl.root.program.instructions?.length, idl.from];
    };
    assert.deepEqual(await read(JUPITER, 'anchor'), ['jupiter', 19, 'anchor']);
    assert.deepEqual(await read(CLMM, 'metadata'), ['raydiumClmm', 39, 'metadata']);
    assert.deepEqual(await read(MOONSHOT, 'anchor'), ['tokenLaunchpad', 6, 'anchor']); // the spec before 0.30
});

test('tells real instructions with their IDL: name, arguments, and what each account is', async () => {
    const jupiter = told([(await idlOf(JUPITER, 'anchor'))!], sample(JUPITER))!;
    assert.equal(jupiter.name, 'RouteV2');
    assert.match(jupiter.args, /^inAmount 6,133,904 · quotedOutAmount 7,191,875,603 · slippageBps 10,000 · /);
    assert.deepEqual(jupiter.accounts.slice(0, 3).map((a) => a.role), ['userTransferAuthority', 'userSourceTokenAccount', 'userDestinationTokenAccount']);
    assert.deepEqual(jupiter.accounts.map((a) => a.address), sample(JUPITER).accounts);
    assert.deepEqual([jupiter.program, jupiter.from], ['jupiter', 'anchor']);

    const clmm = told([(await idlOf(CLMM, 'metadata'))!], sample(CLMM))!;
    assert.deepEqual([clmm.name, clmm.args, clmm.accounts[0].role], ['SwapV2', 'amount 1,104,166,991 · otherAmountThreshold 301,374 · sqrtPriceLimitX64 0 · isBaseInput true', 'payer']);

    const moon = told([(await idlOf(MOONSHOT, 'anchor'))!], sample(MOONSHOT))!;
    assert.deepEqual([moon.name, moon.accounts[0].role], ['Buy', 'sender']);
    assert.match(moon.args, /^data \{tokenAmount 350,430,294,744,340, collateralAmount 10,000,000, /);
});

test('an instruction its first IDL does not know is told by the next: a partial one in the metadata, Anchor’s whole', async () => {
    const whole = (await idlOf(JUPITER, 'anchor'))!;
    const partial: Idl = { from: 'metadata', root: { ...whole.root, program: { ...whole.root.program, instructions: whole.root.program.instructions?.slice(0, 2) } } };
    assert.equal(told([partial], sample(JUPITER)), null);
    assert.equal(told([partial, whole], sample(JUPITER))?.from, 'anchor');
    assert.equal(told([whole], { data: Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]).toString('base64'), accounts: [] }), null); // no discriminator of it
});

test('reads nothing but an IDL: of another owner or program, not canonical, held elsewhere, cut short, or a bomb', async () => {
    const meta = fixture(CLMM, 'metadata');
    const raw = bytes(meta.data);
    const changed = (at: number, value: number) => Object.assign(new Uint8Array(raw), { [at]: value });
    assert.equal(await readIdl(stored(SYSTEM, raw), 'metadata', CLMM), null); // not the Program Metadata Program's
    assert.equal(await readIdl(stored(PROGRAM_METADATA, raw), 'metadata', JUPITER), null); // another program's
    assert.equal(await readIdl(stored(PROGRAM_METADATA, changed(66, 0)), 'metadata', CLMM), null); // not canonical
    assert.equal(await readIdl(stored(PROGRAM_METADATA, changed(86, 1)), 'metadata', CLMM), null); // a URL, never fetched
    assert.equal(await readIdl(stored(PROGRAM_METADATA, changed(83, 2)), 'metadata', CLMM), null); // base58
    assert.equal(await readIdl(stored(PROGRAM_METADATA, raw.slice(0, 500)), 'metadata', CLMM), null);
    const anchor = fixture(JUPITER, 'anchor');
    assert.equal(await readIdl(stored(SYSTEM, bytes(anchor.data)), 'anchor', JUPITER), null); // Anchor's is the program's own
    assert.equal(await readIdl({ exists: false, address: anchor.address }, 'anchor', JUPITER), null);
    // 3 MB of spaces in a few kilobytes: given up past 2 MB, compressed either way.
    const bomb = new Uint8Array(3 * 1024 * 1024).fill(32);
    assert.equal(await readIdl(anchorAccount(SOME, bomb), 'anchor', SOME), null);
    assert.equal(await readIdl(anchorAccount(SOME, bomb, (b) => gzipSync(b)), 'anchor', SOME), null);
    assert.equal(await readIdl(anchorAccount(SOME, 'not json'), 'anchor', SOME), null);
    assert.equal(await readIdl(anchorAccount(SOME, '{"name":"x"}'), 'anchor', SOME), null);
});

test('refuses types that would take forever to build or to read, and tells the rest', async () => {
    const idl = async (args: unknown[], types: unknown[] = []) => (await readIdl(anchorAccount(SOME, anchorIdl(args, types)), 'anchor', SOME))!;
    const time = (f: () => unknown) => {
        const t = performance.now();
        f();
        return performance.now() - t;
    };
    // Each type twice the next: 2^30 nodes to build.
    const doubling = Array.from({ length: 30 }, (_, i) => ({ name: `T${i}`, type: { kind: 'struct', fields: ['a', 'b'].map((f) => ({ name: f, type: i === 29 ? 'u8' : { defined: { name: `T${i + 1}` } } })) } }));
    const exponential = await idl([{ name: 'x', type: { defined: { name: 'T0' } } }], doubling);
    assert.ok(time(() => assert.equal(tellWith([exponential], data(0), [PAYER]), null)) < 500);
    // A type within itself.
    const recursive = await idl([{ name: 'x', type: { defined: { name: 'Node' } } }], [{ name: 'Node', type: { kind: 'struct', fields: [{ name: 'next', type: { vec: { defined: { name: 'Node' } } } }] } }]);
    assert.equal(tellWith([recursive], data(0, 0, 0, 0), [PAYER]), null);
    // A list of things that take no bytes, four billion of them; such things in fixed lists within fixed lists; and
    // types that double down to nothing, whose emptiness alone would take 2^30 steps to work out.
    const nothing = { name: 'Nothing', type: { kind: 'struct', fields: [] } };
    const empties = await idl([{ name: 'x', type: { vec: { defined: { name: 'Nothing' } } } }], [nothing]);
    assert.ok(time(() => assert.equal(tellWith([empties], data(255, 255, 255, 255), [PAYER]), null)) < 500);
    const cubed = await idl([{ name: 'x', type: { array: [{ array: [{ array: [{ defined: { name: 'Nothing' } }, 1024] }, 1024] }, 1024] } }], [nothing]);
    assert.ok(time(() => assert.equal(tellWith([cubed], data(0), [PAYER]), null)) < 500);
    const hollow = doubling.map((t, i) => (i === 29 ? { name: 'T29', type: { kind: 'struct', fields: [] } } : t));
    const doublingToNothing = await idl([{ name: 'x', type: { vec: { defined: { name: 'T0' } } } }], hollow);
    assert.ok(time(() => assert.equal(tellWith([doublingToNothing], data(255, 255, 255, 255), [PAYER]), null)) < 500);
    // Generic types nesting, which Codama writes out at each use: a few hundred bytes, millions of nodes. Refused before
    // they are converted.
    const generic = Array.from({ length: 24 }, (_, i) => ({ name: `G${i}`, generics: [{ kind: 'type', name: 'T' }], type: { kind: 'struct', fields: ['a', 'b'].map((f) => ({ name: f, type: i === 23 ? 'u8' : { defined: { name: `G${i + 1}`, generics: [{ kind: 'type', type: 'u8' }] } } })) } }));
    const start = performance.now();
    assert.equal(await readIdl(anchorAccount(SOME, anchorIdl([{ name: 'x', type: { defined: { name: 'G0', generics: [{ kind: 'type', type: 'u8' }] } } }], generic)), 'anchor', SOME), null);
    assert.ok(performance.now() - start < 500);
    // What is fine is told.
    const fine = await idl([{ name: 'amount', type: 'u64' }, { name: 'memo', type: 'string' }, { name: 'to', type: 'pubkey' }, { name: 'list', type: { vec: 'u8' } }, { name: 'maybe', type: { option: 'u16' } }]);
    const args = [...new Uint8Array(new BigUint64Array([1_000_000n]).buffer), 2, 0, 0, 0, 104, 105, ...getAddressEncoder().encode(PAYER), 2, 0, 0, 0, 7, 8, 1, 5, 0];
    assert.deepEqual(tellWith([fine], data(...args), [PAYER]), { name: 'Boom', args: `amount 1,000,000 · memo "hi" · to ${PAYER.slice(0, 4)}…${PAYER.slice(-4)} · maybe 5 · list [7, 8]`, accounts: [{ role: 'user', address: PAYER }], program: 'evil', from: 'anchor' });
});

test('names from an IDL are shown without characters that move or hide others, and kept short', async () => {
    const idl = (await readIdl(anchorAccount(SOME, anchorIdl([{ name: 'a‮b', type: 'u8' }], [], `send‮evil${'x'.repeat(80)}`)), 'anchor', SOME))!;
    const t = tellWith([idl], data(1), [PAYER, key(31)])!;
    assert.equal(t.name.includes('‮'), false);
    assert.ok(t.name.startsWith('SendEvil') && t.name.length <= 48);
    assert.equal(t.args, 'aB 1'); // the override gone; Codama takes it as a break between words
    assert.deepEqual(t.accounts.map((a) => a.role), ['user', 'account 2']); // past the IDL's list, by number
});

test('a program’s name from its own IDL: plain letters, folded and kept short; with a letter of another script, none', async () => {
    const idl = (await readIdl(anchorAccount(SOME, anchorIdl([{ name: 'x', type: 'u8' }])), 'anchor', SOME))!;
    const named = (name: string) => tellWith([{ ...idl, root: { ...idl.root, program: { ...idl.root.program, name: name as typeof idl.root.program.name } } }], data(1), [PAYER])!.program;
    assert.equal(named('Ｊｕｐｉｔｅｒ'), 'Jupiter'); // fullwidth
    assert.equal(named('Jupit\u0435r'), ''); // a Cyrillic е
    assert.equal(named('raydium\u202Eclmm'), '');
    assert.equal(named(`long${'x'.repeat(80)}`).length, 48);
});

// A program Otus doesn't know gets your signature: what the review says of it, held by guards or not, what it calls
// inside (`calls`; `listed`: whether the RPC listed them), and with its IDL (`told`: the name it gives itself there).
async function unknownCall(o: { cosigned?: boolean; told?: string; calls?: Address[]; listed?: boolean } = {}) {
    const payer = createNoopSigner(PAYER);
    const call = { programAddress: SOME, accounts: [{ address: PAYER, role: AccountRole.WRITABLE_SIGNER }], data: data(1) };
    const extra = o.cosigned ? [getTransferSolInstruction({ source: createNoopSigner(key(32)), destination: key(33), amount: 1n })] : [];
    const tx = transaction([call, ...extra, ...(o.cosigned ? [] : [getTransferSolInstruction({ source: payer, destination: key(33), amount: 1n })])]);
    const simulation: Partial<Simulation> = { inner: [{ index: 0, calls: (o.calls ?? []).map((program) => ({ program, type: null })) }], innerListed: o.listed ?? true };
    const chain = fakeChain([account(PAYER, SYSTEM, 5_000_000n)], [account(PAYER, SYSTEM, 4_994_999n)], simulation);
    const r = await review(tx, { wallet: PAYER, signedBefore: 0, host: 'app.example.com' }, chain);
    const p = await prepare(r, PAYER, chain);
    const told = new Map(o.told ? [[0, { name: 'Boom', args: 'x 1', accounts: [{ role: 'user', address: PAYER }], program: o.told, from: 'anchor' as const }]] : []);
    return describe(r, p, { site: siteView('https://app.example.com', { account: PAYER, signatures: 3 }), account: { label: 'Me', address: PAYER }, signer: 'ready', cluster: 'solana:mainnet', known: { tokens: new Map(), decimals: new Map(), told } });
}

test('a program Otus doesn’t know: a warning, a notice once its own IDL describes it; critical only for what it does', async () => {
    const said = (v: Awaited<ReturnType<typeof unknownCall>>) => [v.verdict, ...v.findings.filter((f) => f.tone === 'danger' || / not a program Otus knows$/.test(f.title)).map((f) => `${f.tone}: ${f.title}`)];
    const unknown = `${SOME.slice(0, 4)}…${SOME.slice(-4)} is not a program Otus knows`;
    assert.deepEqual(said(await unknownCall()), ['warn', `warn: ${unknown}`]);
    assert.deepEqual(said(await unknownCall({ told: 'evil' })), ['ok', 'notice: Evil is not a program Otus knows']);
    // What it calls inside with your signature: moving SOL, itself, another program, all as they are; but Kamino Lend,
    // where it could act on loans of yours that no balance shows, is critical; and so is not seeing what it calls.
    assert.deepEqual(said(await unknownCall({ calls: [SYSTEM, SOME, key(40)] })), ['warn', `warn: ${unknown}`]);
    const KAMINO = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD' as Address;
    assert.deepEqual(said(await unknownCall({ calls: [SYSTEM, KAMINO], told: 'evil' })), ['danger', 'danger: An unknown program uses your signature in Kamino Lend', 'notice: Evil is not a program Otus knows']);
    assert.deepEqual(said(await unknownCall({ listed: false })), ['danger', "danger: Otus can't see what an unknown program does with your signature", `warn: ${unknown}`]);
    // Without guards its own IDL binds nothing: a warning still; the Guards line says nothing.
    const loose = await unknownCall({ cosigned: true });
    assert.deepEqual([loose.guards.held, loose.guards.text], [false, '']);
    assert.deepEqual(said(loose), ['warn', `warn: ${unknown}`]);
    assert.deepEqual(said(await unknownCall({ cosigned: true, told: 'evil' })), ['warn', 'warn: Evil is not a program Otus knows']);
    // A name borrowed from a program Otus knows.
    assert.deepEqual(said(await unknownCall({ told: 'jupiterAggregator' })), ['danger', 'danger: An unknown program calls itself Jupiter Aggregator', 'notice: Jupiter Aggregator is not a program Otus knows']);
});

test('a name borrowed from a brand, a wallet or a program every transaction uses, by whole words; plain words and names forks keep, no', async () => {
    const posing = async (told: string) => (await unknownCall({ told })).findings.filter((f) => f.title.includes(' calls itself ')).map((f) => f.title.replace('An unknown program calls itself ', ''));
    for (const told of ['tokenProgram', 'phantomRewards', 'pumpFunAmm', 'okxRouter', 'driftVaultsV2']) assert.equal((await posing(told)).length, 1, told);
    // One word: a brand and what its products are called, or digits read as letters, or "real" before it.
    for (const told of ['jupiterv6', 'jupiter6', 'jupiteraggregator', 'Jupiterswap', 'JUPITERAGGREGATOR', 'kaminolend', 'marginfiv2', 'raydiumamm', 'orcawhirlpool', 'jup1ter', 'realjupiter']) assert.equal((await posing(told)).length, 1, told);
    for (const told of ['pythonUtils', 'voteEscrow', 'splGovernance', 'stakePool', 'driftwood', 'memoLogger', 'orcanaut', 'tensorflow', 'mangoes']) assert.deepEqual(await posing(told), [], told);
    // The whole name of one of Solana's own programs.
    for (const told of ['System', 'token', 'Stake', 'Memo', 'UpgradeableLoader', 'native_loader']) assert.equal((await posing(told)).length, 1, told);
});

test('shows an instruction as its IDL tells it, and a program Otus doesn’t know by the name its IDL gives', async () => {
    const view = await unknownCall({ told: 'evil' });
    const program = view.programs.find((p) => p.address === SOME)!;
    assert.deepEqual([program.name, program.standing], ['Evil', 'described']);
    const ix = program.instructions[0];
    assert.deepEqual([ix.name, ix.args, ix.source, ix.accounts[0].role.split(' · ')[0]], ['Boom', 'x 1', 'idl', 'user']);
    const plain = (await unknownCall()).programs.find((p) => p.address === SOME)!;
    assert.deepEqual([plain.name, plain.standing, plain.instructions[0].source, plain.instructions[0].name], ['Unknown program', 'unknown', 'unknown', 'Unknown instruction']);
    assert.equal(view.programs.find((p) => p.address === SYSTEM)?.standing, 'known');
});

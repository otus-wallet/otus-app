import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getTransferSolInstruction } from '@solana-program/system';
import { getCreateAssociatedTokenIdempotentInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
    AccountRole,
    appendTransactionMessageInstruction,
    blockhash,
    compileTransaction,
    createNoopSigner,
    createTransactionMessage,
    generateKeyPair,
    getAddressFromPublicKey,
    getBase58Encoder,
    getBase64Decoder,
    getBase64Encoder,
    getSolanaErrorFromJsonRpcError,
    getTransactionDecoder,
    getTransactionEncoder,
    lamports,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    signBytes,
    SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
    SolanaError,
    verifySignature,
    type Address,
    type Blockhash,
    type SignatureBytes,
} from '@solana/kit';

import { LIGHTHOUSE } from '../src/programs/addresses.ts';
import { Refused, type Reply } from '../src/protocol.ts';
import { decode } from '../src/review/decode.ts';
import { transfer as sendTransfer } from '../src/send/transfer.ts';
import { send } from '../src/send/send.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import type { Answer } from '../src/shell/approvals.ts';
import { own, serve, type Shell } from '../src/shell/serve.ts';
import type { Chain } from '../src/chain.ts';
import type { State } from '../src/shell/state.ts';
import type { Approval } from '../src/ui/view.ts';
import { account, fakeChain, key, SYSTEM, tokenAccountData } from './helpers.ts';

const ORIGIN = 'https://jup.ag';
const base64 = (b: Uint8Array) => getBase64Decoder().decode(b);
const bytes = (s: string) => new Uint8Array(getBase64Encoder().encode(s));

const NOW = 1_791_000_000_000; // ms: the fake extension's time
const LEDGER_PATH = "44'/501'/0'/0'";

/** A wallet with a real key, a site connected to it, and a fake extension around serve. `chain` changes the network's
 *  answers; sends are watched without waiting between checks. */
async function wallet(o: { key?: boolean; ledger?: boolean; locked?: boolean; answer?: (a: Approval, s: { state: State }) => Answer | Promise<Answer>; validOn?: string[]; chain?: Partial<Chain>; slow?: number } = {}) {
    const pair = await generateKeyPair();
    const me = await getAddressFromPublicKey(pair.publicKey);
    const box = {
        state: {
            accounts: [{ address: me, label: 'Me', ...(o.ledger ? { ledger: { path: LEDGER_PATH } } : o.key !== false && { key: { secret: 's', index: 0 } }) }],
            active: me,
            sites: { [ORIGIN]: { account: me, signatures: 0 } },
            contacts: [],
            sent: {},
            removed: [],
            settings: DEFAULT_SETTINGS,
        } as State,
    };
    const approvals: Approval[] = [];
    const firsts: Approval[] = []; // the first form of each, shown before it is prepared
    const shownAt: { first: number[]; final: number[] } = { first: [], final: [] }; // when each form came
    const sent: Uint8Array[] = [];
    const quick = fakeChain([account(me, SYSTEM, 5_000_000_000n)], [account(me, SYSTEM, 4_998_995_000n), account(key(2), SYSTEM, 1_000_000n)], {}, {
        send: async (tx) => void sent.push(tx),
        status: async () => ({ error: null, confirmed: true }),
        ...o.chain,
    });
    // `slow`: every answer of the network takes that many ms, as a round trip does.
    const chain: Chain = o.slow
        ? (Object.fromEntries(Object.entries(quick).map(([k, f]) => [k, async (...args: unknown[]) => (await new Promise((r) => setTimeout(r, o.slow)), (f as (...a: unknown[]) => unknown)(...args))])) as Chain)
        : quick;
    const looked: string[][] = []; // the mints Jupiter was asked about
    const shell: Shell = {
        load: async () => box.state,
        update: async (change) => void (box.state = { ...box.state, ...(change(box.state) ?? {}) }),
        // As the window: the first form shown, the final one (when it comes) the only one answered.
        approve: async (a, _follow, later) => {
            firsts.push(a);
            shownAt.first.push(performance.now());
            const final = later ? await later : a;
            shownAt.final.push(performance.now());
            approvals.push(final);
            return o.answer ? o.answer(final, box) : true;
        },
        sign: async (_account, data): Promise<SignatureBytes> => {
            if (o.locked) throw new Refused('Otus is locked');
            return signBytes(pair.privateKey, data);
        },
        chain: (rpc) => ({ ...chain, valid: o.chain?.valid ?? (async () => !o.validOn || o.validOn.includes(rpc)) }), // validOn: the RPCs that know the blockhash
        send: (tx, on) => send(tx, on, async () => {}),
        tokens: async (mints) => (looked.push(mints), new Map()),
        now: () => NOW,
    };
    // A transfer of 0.001 SOL to key(2) from `from`, its fee paid by `payer`.
    const transfer = (from: Address = me, payer: Address = from, version: 0 | 1 = 0) =>
        base64(
            new Uint8Array(
                getTransactionEncoder().encode(
                    compileTransaction(
                        pipe(
                            createTransactionMessage({ version }),
                            (m) => setTransactionMessageFeePayer(payer, m),
                            (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m),
                            (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: createNoopSigner(from), destination: key(2), amount: lamports(1_000_000n) }), m),
                        ),
                    ),
                ),
            ),
        );
    const call = (method: string, params: object, origin = ORIGIN) => serve({ method, params }, origin, shell);
    return { me, pair, box, approvals, firsts, shownAt, sent, looked, transfer, call, shell };
}

const result = <T>(reply: Reply): T => {
    assert.ok(reply.ok, reply.ok ? '' : reply.error);
    return reply.result as T;
};

test('signs the transaction as approved, guards and fees included, with your signature in its place', async () => {
    const w = await wallet();
    const { transactions } = result<{ transactions: string[] }>(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }));
    const signed = getTransactionDecoder().decode(bytes(transactions[0]));
    assert.ok(await verifySignature(w.pair.publicKey, signed.signatures[w.me]!, signed.messageBytes));
    const shown = w.approvals[0];
    assert.equal(shown.kind === 'transaction' && shown.signer, 'ready');
    assert.match(shown.kind === 'transaction' ? shown.guards.text : '', /guard/);
    assert.equal(w.box.state.sites[ORIGIN].signatures, 1);
    assert.equal(w.box.state.sites[ORIGIN].since, NOW / 1000); // the first transaction: known a day later
    assert.equal(w.sent.length, 0);
});

test('a transfer made in the popup is not signed once its blockhash is too old, and says when it is signed', async () => {
    const old = await wallet({ validOn: [] });
    assert.deepEqual(await own(bytes(old.transfer()), old.me, key(2), old.shell), { ok: false, error: 'it expired before you signed it, so nothing was sent' });
    assert.equal(old.sent.length, 0);
    assert.equal(old.box.state.accounts[0].signatures ?? 0, 0);
    assert.deepEqual(old.box.state.sent, {});
    const w = await wallet();
    assert.deepEqual(await own(bytes(w.transfer()), w.me, 'not an address', w.shell), { ok: false, error: 'that is not a Solana address' });
    const told: string[] = [];
    const { signature } = result<{ signature: string }>(await own(bytes(w.transfer()), w.me, key(2), w.shell, async (s) => void told.push(s)));
    assert.deepEqual(told, [signature]); // before it was sent: a worker that stops can still tell
});

test('a transfer made in the popup is reviewed as Otus’s own, signed and sent, and counts for the wallet only', async () => {
    const w = await wallet();
    const reply = await own(bytes(w.transfer()), w.me, key(2), w.shell);
    const { signature, outcome } = result<{ signature: string; outcome: string }>(reply);
    assert.equal(outcome, 'confirmed');
    assert.equal(w.sent.length, 1);
    assert.deepEqual(new Uint8Array(getBase58Encoder().encode(signature)), new Uint8Array(getTransactionDecoder().decode(w.sent[0]).signatures[w.me]!));
    const shown = w.approvals[0];
    assert.ok(shown.kind === 'transaction');
    assert.deepEqual([shown.site.host, shown.site.note, shown.recipient], ['Otus', 'Your own transfer', key(2)]);
    assert.ok(shown.findings.some((f) => f.title === 'Made in Otus') && !shown.findings.some((f) => /site/.test(f.title)));
    assert.equal(w.box.state.accounts[0].signatures, 1);
    assert.equal(w.box.state.sites[ORIGIN].signatures, 0);
    assert.deepEqual(w.box.state.sent, { [key(2)]: 1 }); // landed there: the address is one you sent to
    // Only for an account Otus holds a key for, and that alone signs it.
    assert.match((await own(bytes(w.transfer()), key(5), key(2), w.shell) as { error: string }).error, /no key/);
    // The address shown whole is one the transfer names.
    assert.match((await own(bytes(w.transfer()), w.me, key(3), w.shell) as { error: string }).error, /does not name the address you typed/);
    const rejected = await wallet({ answer: () => false });
    assert.deepEqual(await own(bytes(rejected.transfer()), rejected.me, key(2), rejected.shell), { ok: false, error: 'You rejected it', rejected: true });
    assert.deepEqual(rejected.box.state.sent, {});
    assert.equal(rejected.sent.length, 0);
});

test('a transfer made in the popup never opens a token account for an address that is a token account itself', async () => {
    // key(2) holds tokens for key(6): an account opened for key(2) would be one no key can ever move.
    const held = account(key(2), TOKEN_PROGRAM_ADDRESS, 2_039_280n, tokenAccountData({ mint: key(31), owner: key(6), amount: 5n }));
    const w = await wallet({ chain: fakeChain([held], [held]) });
    const open = getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(w.me), ata: key(30), owner: key(2), mint: key(31) });
    const tx = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(w.me, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m),
        (m) => appendTransactionMessageInstruction(open, m),
    );
    const reply = (await own(new Uint8Array(getTransactionEncoder().encode(compileTransaction(tx))), w.me, key(2), w.shell)) as { error: string };
    assert.match(reply.error, /token account or a mint, not a wallet/);
    assert.equal(w.sent.length, 0);
});

test('a site gets one review at a time, and what its bytes alone refuse costs no RPC', async () => {
    let asked = 0; // network checks: each review starts with one
    const w = await wallet({ chain: { valid: async () => (asked++, true) } });
    const [one, two] = await Promise.all([w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }), w.call('signTransaction', { account: w.me, transactions: [w.transfer()] })]);
    assert.equal([one, two].filter((r) => r.ok).length, 1);
    assert.match(([one, two].find((r) => !r.ok) as { error: string }).error, /already asking you/);
    // Paid by another account whose signature is missing, it cannot be sent: refused before any review.
    asked = 0;
    const cosigned = await w.call('signAndSendTransaction', { account: w.me, transactions: [w.transfer(w.me, key(5))] });
    assert.match((cosigned as { error: string }).error, /another signature is missing/);
    assert.equal(asked, 0);
});

test('signs and sends, and answers with the signature once it lands', async () => {
    const w = await wallet();
    const { signatures } = result<{ signatures: string[] }>(await w.call('signAndSendTransaction', { account: w.me, transactions: [w.transfer()] }));
    assert.equal(w.sent.length, 1);
    const landed = getTransactionDecoder().decode(w.sent[0]);
    assert.deepEqual(new Uint8Array(getBase58Encoder().encode(signatures[0])), new Uint8Array(landed.signatures[w.me]!));
});

test('signs a message, and a sign-in that the site can check', async () => {
    const w = await wallet();
    const text = new TextEncoder().encode('Hello from jup.ag');
    const m = result<{ signedMessage: string; signature: string }>(await w.call('signMessage', { account: w.me, message: base64(text) }));
    assert.deepEqual(bytes(m.signedMessage), text);
    assert.ok(await verifySignature(w.pair.publicKey, bytes(m.signature) as SignatureBytes, text));

    w.box.state = { ...w.box.state, sites: {} };
    const input = { statement: 'Sign in to Jupiter', uri: ORIGIN, version: '1', nonce: 'abc12345', issuedAt: '2026-10-03T12:00:00Z', resources: ['https://jup.ag/terms'] };
    const s = result<{ account: string; signedMessage: string; signature: string }>(await w.call('signIn', input));
    const expected = `jup.ag wants you to sign in with your Solana account:\n${w.me}\n\nSign in to Jupiter\n\nURI: https://jup.ag\nVersion: 1\nNonce: abc12345\nIssued At: 2026-10-03T12:00:00Z\nResources:\n- https://jup.ag/terms`;
    assert.equal(new TextDecoder().decode(bytes(s.signedMessage)), expected);
    assert.ok(await verifySignature(w.pair.publicKey, bytes(s.signature) as SignatureBytes, bytes(s.signedMessage)));
    assert.equal(w.box.state.sites[ORIGIN]?.account, w.me); // signing in connects the site
});

test('an address you only watch is reviewed but never signed for', async () => {
    const w = await wallet({ key: false });
    const reply = await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] });
    assert.equal(w.approvals[0].kind === 'transaction' && w.approvals[0].signer, 'none');
    assert.deepEqual(reply, { ok: false, error: 'Otus holds no key for this account' });
});

test('the review is shown behind the lock, which the window keeps; signing still needs the keystore unlocked', async () => {
    const w = await wallet({ locked: true });
    const reply = await w.call('signMessage', { account: w.me, message: base64(new TextEncoder().encode('hi')) });
    assert.equal(w.approvals[0].kind === 'message' && w.approvals[0].signer, 'ready');
    assert.deepEqual(reply, { ok: false, error: 'Otus is locked' });
});

test('signs nothing for a site disconnected while the user was deciding', async () => {
    const w = await wallet({ answer: (_a, box) => ((box.state = { ...box.state, sites: {} }), true) });
    const reply = await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] });
    assert.deepEqual(reply, { ok: false, error: 'this site is not connected to that account' });
});

test('a rejection, or a transaction that does not need you, signs nothing', async () => {
    const w = await wallet({ answer: () => false });
    assert.deepEqual(await w.call('signMessage', { account: w.me, message: base64(new Uint8Array([1, 2, 3])) }), { ok: false, error: 'The user rejected the request', rejected: true });
    const other = await wallet();
    const reply = await other.call('signTransaction', { account: other.me, transactions: [other.transfer(key(3))] });
    assert.equal(reply.ok, false);
    assert.equal(other.approvals.length, 0);
});

test('connecting with another of your accounts, chosen in the window: it connects, and is the one in use', async () => {
    const other = key(5);
    const withTwo = (box: { state: State }) => (box.state = { ...box.state, accounts: [...box.state.accounts, { address: other, label: 'Other', key: { secret: 's', index: 1 } }] });
    const w = await wallet({ answer: (a, box) => (a.kind === 'connect' ? { account: other } : true) });
    withTwo(w.box);
    assert.deepEqual(result(await w.call('connect', {}, 'https://new.app')), { accounts: [other], v1: true });
    assert.deepEqual([w.box.state.sites['https://new.app']?.account, w.box.state.active], [other, other]);
    const shown = w.approvals[0];
    assert.deepEqual(shown.kind === 'connect' && shown.choices.map((c) => c.address), [w.me, other]); // the window offers your accounts

    // An address that is not one of yours connects nothing.
    const stranger = await wallet({ answer: () => ({ account: key(6) }) });
    assert.equal((await stranger.call('connect', {}, 'https://new.app')).ok, false);
    assert.equal(stranger.box.state.sites['https://new.app'], undefined);
    // To sign, an account chosen is a no.
    const signing = await wallet({ answer: () => ({ account: key(6) }) });
    assert.equal((await signing.call('signMessage', { account: signing.me, message: base64(new TextEncoder().encode('hi')) })).ok, false);
    assert.equal((await signing.call('signTransaction', { account: signing.me, transactions: [signing.transfer()] })).ok, false);
});

test('a watched account never connects: the window offers those that sign, and only they connect', async () => {
    const signer = key(5);
    const withSigner = (box: { state: State }) => (box.state = { ...box.state, accounts: [...box.state.accounts, { address: signer, label: 'Signs', key: { secret: 's', index: 1 } }] });
    // The one in use only watches: a plain yes connects nothing; choosing one that signs does.
    const yes = await wallet({ key: false });
    withSigner(yes.box);
    assert.equal((await yes.call('connect', {}, 'https://new.app')).ok, false);
    assert.equal(yes.box.state.sites['https://new.app'], undefined);
    const shown = yes.approvals[0];
    assert.deepEqual(shown.kind === 'connect' && shown.choices.map((c) => c.address), [signer]); // the watched one is not offered
    const chose = await wallet({ key: false, answer: () => ({ account: signer }) });
    withSigner(chose.box);
    assert.deepEqual(result(await chose.call('connect', {}, 'https://new.app')), { accounts: [signer], v1: true });
    // Naming the watched one is a no; with no account that signs, no window opens.
    const named = await wallet({ key: false, answer: (_a, box) => ({ account: box.state.accounts[0].address }) });
    withSigner(named.box);
    assert.equal((await named.call('connect', {}, 'https://new.app')).ok, false);
    const none = await wallet({ key: false });
    assert.deepEqual(await none.call('connect', {}, 'https://new.app'), { ok: false, error: 'no account in Otus can sign: a watched one cannot connect' });
    assert.equal(none.approvals.length, 0);
});

test('connecting keeps what changed while the user was deciding', async () => {
    const w = await wallet({ answer: (_a, box) => ((box.state = { ...box.state, sites: {} }), true) }); // jup.ag disconnected meanwhile
    result(await w.call('connect', {}, 'https://new.app'));
    assert.deepEqual(Object.keys(w.box.state.sites), ['https://new.app']);
});

test('reviews a transaction on the network that knows its blockhash, and refuses one named for another', async () => {
    const devnet = 'https://api.devnet.solana.com';
    const named = await wallet({ validOn: [devnet] });
    const reply = await named.call('signTransaction', { account: named.me, chain: 'solana:mainnet', transactions: [named.transfer()] });
    assert.deepEqual(reply, { ok: false, error: 'this transaction is not for mainnet' });
    assert.equal(named.approvals.length, 0);

    const guessed = await wallet({ validOn: [devnet] });
    result(await guessed.call('signTransaction', { account: guessed.me, transactions: [guessed.transfer()] }));
    const shown = guessed.approvals[0];
    assert.equal(shown.kind === 'transaction' && shown.network, 'devnet');
    assert.equal((await wallet({ validOn: [] })).approvals.length, 0);
});

test('a connected site signs in with its account only; another site cannot learn which accounts Otus holds', async () => {
    const w = await wallet();
    assert.deepEqual(await w.call('signIn', { address: key(5) }), { ok: false, error: 'that account is not connected to this site' });
    const elsewhere = result<{ account: string }>(await w.call('signIn', { address: key(5) }, 'https://other.app'));
    assert.equal(elsewhere.account, w.me); // the account in use, whatever address the site named
});

// What the RPC answers a send whose blockhash it does not know, as kit reads it.
const blockhashNotFound = () => getSolanaErrorFromJsonRpcError({ code: -32002, message: 'Transaction simulation failed: Blockhash not found', data: { err: 'BlockhashNotFound', logs: [], accounts: null, unitsConsumed: 0 } });
const http = (statusCode: number) => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: '', statusCode });

test('your own transfer is yours alone to sign, and signed only while the account is still in Otus', async () => {
    const w = await wallet();
    assert.deepEqual(await own(bytes(w.transfer(w.me, key(3))), w.me, key(2), w.shell), { ok: false, error: 'another account would have to sign it' });
    assert.equal(w.approvals.length, 0);
    const removed = await wallet({ answer: (_a, box) => ((box.state = { ...box.state, accounts: [] }), true) });
    assert.deepEqual(await own(bytes(removed.transfer()), removed.me, key(2), removed.shell), { ok: false, error: 'Otus holds no key for this account' });
    assert.equal(removed.sent.length, 0);
});

test('a site gets nothing signed for an account removed while the user was deciding', async () => {
    const w = await wallet({ answer: (_a, box) => ((box.state = { ...box.state, accounts: [] }), true) });
    assert.deepEqual(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }), { ok: false, error: 'this site is not connected to that account' });
});

test('a transaction another account must sign too is signed, but not sent while its signature is missing', async () => {
    const w = await wallet();
    const tx = w.transfer(w.me, key(3));
    assert.deepEqual(await w.call('signAndSendTransaction', { account: w.me, transactions: [tx] }), { ok: false, error: 'another signature is missing, so it cannot be sent' });
    const { transactions } = result<{ transactions: string[] }>(await w.call('signTransaction', { account: w.me, transactions: [tx] }));
    const signed = getTransactionDecoder().decode(bytes(transactions[0]));
    assert.ok(signed.signatures[w.me] && !signed.signatures[key(3)]);
    const shown = w.approvals[0];
    assert.deepEqual(shown.kind === 'transaction' && shown.guards, { held: false, text: '' }); // no guards, and nothing said of why
});

test('a send the network refuses, or one that expires before it lands, is said in words on both ways in', async () => {
    const refused = await wallet({ chain: { send: async () => { throw blockhashNotFound(); } } });
    const expected = { ok: false, error: 'it expired before it was sent, so nothing was sent' };
    assert.deepEqual(await refused.call('signAndSendTransaction', { account: refused.me, transactions: [refused.transfer()] }), expected);
    assert.deepEqual(await own(bytes(refused.transfer()), refused.me, key(2), refused.shell), expected);
    // The blockhash is known while reviewing and signing, then no longer: unseen, the transfer expires. A site's goes by
    // two checks before signing (its network, then its blockhash once approved); your own, by the second only.
    let checks = 0;
    let known = 2;
    const late = await wallet({ chain: { status: async () => null, valid: async () => ++checks <= known } });
    assert.deepEqual(await late.call('signAndSendTransaction', { account: late.me, transactions: [late.transfer()] }), { ok: false, error: 'it expired before it landed, so nothing was sent' });
    [checks, known] = [0, 1];
    assert.deepEqual(await own(bytes(late.transfer()), late.me, key(2), late.shell), { ok: false, error: 'it expired before it landed, so nothing was sent' });
});

test('an RPC that turns Otus away, or does not answer, is said so on both ways in', async () => {
    const busy = await wallet({ chain: { accounts: async () => { throw http(429); } } });
    const turnedAway = { ok: false, error: "the RPC refused Otus's request (HTTP 429)" };
    assert.deepEqual(await busy.call('signTransaction', { account: busy.me, transactions: [busy.transfer()] }), turnedAway);
    assert.deepEqual(await own(bytes(busy.transfer()), busy.me, key(2), busy.shell), turnedAway);
    const silent = await wallet({ chain: { accounts: async () => { throw new DOMException('signal timed out', 'TimeoutError'); } } });
    const noAnswer = { ok: false, error: 'the RPC did not answer in time' };
    assert.deepEqual(await silent.call('signTransaction', { account: silent.me, transactions: [silent.transfer()] }), noAnswer);
    assert.deepEqual(await own(bytes(silent.transfer()), silent.me, key(2), silent.shell), noAnswer);
});

test('several transactions in one call are refused before any review', async () => {
    const w = await wallet();
    const reply = await w.call('signTransaction', { account: w.me, transactions: [w.transfer(), w.transfer()] });
    assert.equal(reply.ok, false);
    assert.equal(w.approvals.length, 0);
});

test('token names and prices are asked of Jupiter for mainnet only', async () => {
    const mainnet = await wallet();
    result(await mainnet.call('signTransaction', { account: mainnet.me, transactions: [mainnet.transfer()] }));
    assert.equal(mainnet.looked.length, 1);
    const devnet = await wallet({ validOn: ['https://api.devnet.solana.com'] });
    result(await devnet.call('signTransaction', { account: devnet.me, transactions: [devnet.transfer()] }));
    assert.equal(devnet.looked.length, 0);
});

test('connecting silently answers only a site connected already; disconnecting forgets the site', async () => {
    const w = await wallet();
    assert.deepEqual(result(await w.call('connect', { silent: true })), { accounts: [w.me], v1: true });
    assert.deepEqual(await w.call('connect', { silent: true }, 'https://new.app'), { ok: false, error: 'not connected' });
    assert.equal(w.approvals.length, 0);
    assert.equal(result(await w.call('disconnect', {})), null);
    assert.deepEqual(w.box.state.sites, {});
});

test('a message is shown as text with what is invisible marked, or as hex; signing it counts for the site', async () => {
    const w = await wallet();
    result(await w.call('signMessage', { account: w.me, message: base64(new TextEncoder().encode('pay‮me\u0007\nnow')) }));
    result(await w.call('signMessage', { account: w.me, message: base64(new Uint8Array([0xff, 0xfe, 0x00])) }));
    assert.deepEqual(w.approvals.map((a) => (a.kind === 'message' ? a.text : null)), ['pay�me�\nnow', '0xfffe00']);
    assert.equal(w.box.state.sites[ORIGIN].signatures, 2);
});

test('a sign-in shows and signs every field the site sets, in order', async () => {
    const w = await wallet();
    const input = { statement: 'Hi', uri: ORIGIN, version: '1', chainId: 'mainnet', nonce: 'n0nce123', issuedAt: '2026-10-03T12:00:00Z', expirationTime: '2026-10-04T12:00:00Z', notBefore: '2026-10-03T11:00:00Z', requestId: 'r1' };
    const s = result<{ signedMessage: string }>(await w.call('signIn', input));
    const lines = new TextDecoder().decode(bytes(s.signedMessage)).split('\n').slice(5); // after the address and the statement
    assert.deepEqual(lines, ['URI: https://jup.ag', 'Version: 1', 'Chain ID: mainnet', 'Nonce: n0nce123', 'Issued At: 2026-10-03T12:00:00Z', 'Expiration Time: 2026-10-04T12:00:00Z', 'Not Before: 2026-10-03T11:00:00Z', 'Request ID: r1']);
    const shown = w.approvals[0];
    assert.deepEqual(shown.kind === 'signIn' && shown.fields.map(([k]) => k), ['Domain', 'Address', 'Statement', 'URI', 'Version', 'Chain ID', 'Nonce', 'Issued At', 'Expiration Time', 'Not Before', 'Request ID']);
});

test('the day a site is known from stays the day of its first transaction', async () => {
    const w = await wallet();
    w.box.state = { ...w.box.state, sites: { [ORIGIN]: { account: w.me, signatures: 3, since: 5 } } };
    result(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }));
    assert.deepEqual(w.box.state.sites[ORIGIN], { account: w.me, signatures: 4, since: 5 });
});

test('a site\u2019s transaction whose blockhash runs out while the user decides is not signed', async () => {
    let checks = 0; // known when it came, no longer once approved
    const w = await wallet({ chain: { valid: async () => ++checks <= 1 } });
    assert.deepEqual(await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] }), { ok: false, error: 'it expired before you signed it, so nothing was sent' });
    assert.equal(w.approvals.length, 1);
    assert.equal(w.box.state.sites[ORIGIN].signatures, 0);
    const shown = w.approvals[0];
    assert.equal(shown.kind === 'transaction' && shown.expiry, null); // no time shown: none tells a blockhash's age
});

test('while the user decides, the window hears about when the blockhash ends, by its place among the recent ones', async () => {
    const heard: unknown[] = [];
    const w = await wallet({ chain: { age: async () => 30, blockRate: async () => 3 } });
    w.shell.approve = (_a, follow) => new Promise((done) => follow?.((life) => (heard.push(life), done(false))));
    await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] });
    assert.deepEqual(heard, [{ until: NOW + ((150 - 30) / 3) * 1000 }]); // 120 blocks at 3 a second: 40 s
});

test('off the recent list, the window hears it is gone once the network says it can no longer land', async () => {
    let alive = true;
    const heard: unknown[] = [];
    const w = await wallet({ chain: { age: async () => null, valid: async () => alive } });
    w.shell.approve = (_a, follow) =>
        new Promise((done) =>
            follow?.((life) => {
                heard.push(life);
                if ('expired' in life) return done(false);
                alive = false; // a block or two left: it dies while the user reads
            }),
        );
    const reply = await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] });
    assert.deepEqual(heard, [{ until: NOW }, { expired: true }]);
    assert.equal(reply.ok, false);
});

test('a transfer made in the popup counts for the address it pays, and keeping count never changes how it went', async () => {
    const w = await wallet();
    // An address it only names, read-only beside the transfer to key(2): not one you sent to.
    const named = new Uint8Array(getTransactionEncoder().encode(compileTransaction(pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(w.me, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m),
        (m) => appendTransactionMessageInstruction({ ...getTransferSolInstruction({ source: createNoopSigner(w.me), destination: key(2), amount: lamports(1_000_000n) }), accounts: [...getTransferSolInstruction({ source: createNoopSigner(w.me), destination: key(2), amount: lamports(1_000_000n) }).accounts, { address: key(3), role: AccountRole.READONLY }] }, m),
    ))));
    assert.equal(result<{ outcome: string }>(await own(named, w.me, key(3), w.shell)).outcome, 'confirmed');
    assert.deepEqual(w.box.state.sent, {});
    // Storage failing as it counts: the transfer still landed, and says so.
    const failing = await wallet();
    const update = failing.shell.update;
    failing.shell.update = async (change) => update((s) => {
        const part = change(s);
        if (part && 'sent' in part) throw new Error('storage');
        return part;
    });
    assert.equal(result<{ outcome: string }>(await own(bytes(failing.transfer()), failing.me, key(2), failing.shell)).outcome, 'confirmed');
});

// The Ledger in the window: it signs the message the approval carries, with the account's key.
const onDevice = (key: CryptoKey) => async (a: Approval) => (a.kind === 'transaction' && a.ledger ? signBytes(key, bytes(a.ledger.message)) : false);

test('a Ledger account signs in its window: the approval carries the message, and the signature is checked and put in place', async () => {
    const real: Awaited<ReturnType<typeof wallet>> = await wallet({ ledger: true, answer: (a) => onDevice(real.pair.privateKey)(a) });
    const { transactions } = result<{ transactions: string[] }>(await real.call('signTransaction', { account: real.me, transactions: [real.transfer()] }));
    const signed = getTransactionDecoder().decode(bytes(transactions[0]));
    const shown = real.approvals[0];
    assert.ok(shown.kind === 'transaction' && shown.signer === 'ledger' && shown.ledger);
    assert.deepEqual(shown.ledger, { path: LEDGER_PATH, message: base64(new Uint8Array(signed.messageBytes)) });
    assert.ok(await verifySignature(real.pair.publicKey, signed.signatures[real.me]!, signed.messageBytes));
    assert.equal(real.box.state.accounts[0].signatures, 1);
});

test('a Ledger signature of other bytes, by another key, or none at all, signs nothing', async () => {
    const other = await generateKeyPair();
    const answers: ((w: Awaited<ReturnType<typeof wallet>>) => (a: Approval) => Promise<boolean | SignatureBytes>)[] = [
        (w) => async () => signBytes(w.pair.privateKey, new Uint8Array([1, 2, 3])),
        () => onDevice(other.privateKey),
        () => async () => true,
    ];
    for (const answer of answers) {
        const w: Awaited<ReturnType<typeof wallet>> = await wallet({ ledger: true, answer: (a) => answer(w)(a) });
        const reply = await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] });
        assert.deepEqual(reply, { ok: false, error: 'the Ledger did not sign it with this account' });
        assert.equal(w.box.state.accounts[0].signatures ?? 0, 0);
    }
});

test('a Ledger account signs no messages or sign-ins, asked like any other so a site learns nothing; and no v1 transactions', async () => {
    const w = await wallet({ ledger: true });
    const refused = { ok: false, error: 'a Ledger account signs transactions only, not messages' };
    assert.deepEqual(await w.call('signMessage', { account: w.me, message: base64(new TextEncoder().encode('Hello')) }), refused);
    assert.deepEqual(await w.call('signIn', { statement: 'Sign in' }), refused);
    assert.deepEqual(w.approvals.map((a) => [a.kind, 'signer' in a && a.signer]), [['message', 'ledger'], ['signIn', 'ledger']]); // the window says why it cannot
    // A v1 transaction is shown, with why it cannot be signed, and nothing for the device.
    const v1 = { ok: false, error: 'a Ledger cannot sign version 1 transactions' };
    assert.deepEqual(await w.call('signTransaction', { account: w.me, transactions: [w.transfer(w.me, w.me, 1)] }), v1);
    assert.deepEqual(await own(bytes(w.transfer(w.me, w.me, 1)), w.me, key(2), w.shell), v1);
    const shown = w.approvals[2];
    assert.ok(shown.kind === 'transaction' && shown.blocked && !shown.ledger);
    // Connected, a site hears this account cannot sign v1, and builds what it can.
    w.box.state = { ...w.box.state, sites: { [ORIGIN]: { account: w.me, signatures: 0 } } };
    assert.deepEqual(result(await w.call('connect', { silent: true })), { accounts: [w.me], v1: false });
});

test('a transfer made in the popup from a Ledger account is signed on the device and sent', async () => {
    const w: Awaited<ReturnType<typeof wallet>> = await wallet({ ledger: true, answer: (a) => onDevice(w.pair.privateKey)(a) });
    const { outcome } = result<{ outcome: string }>(await own(bytes(w.transfer()), w.me, key(2), w.shell));
    assert.equal(outcome, 'confirmed');
    const sent = getTransactionDecoder().decode(w.sent[0]);
    assert.ok(await verifySignature(w.pair.publicKey, sent.signatures[w.me]!, sent.messageBytes));
    // SOL alone: no guards, so the device shows the transfer in clear; the review needs not say so.
    const shown = w.approvals[0];
    assert.deepEqual(shown.kind === 'transaction' && shown.guards, { held: false, text: '' });
    assert.ok(!(await decode(w.sent[0])).message.staticAccounts.includes(LIGHTHOUSE));
});

test('only a plain SOL transfer goes without guards from a Ledger: anything more keeps them', async () => {
    const w: Awaited<ReturnType<typeof wallet>> = await wallet({ ledger: true, answer: (a) => onDevice(w.pair.privateKey)(a) });
    const twice = base64(
        new Uint8Array(
            getTransactionEncoder().encode(
                compileTransaction(
                    pipe(
                        createTransactionMessage({ version: 0 }),
                        (m) => setTransactionMessageFeePayer(w.me, m),
                        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash(key(9)), lastValidBlockHeight: 0n }, m),
                        (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: createNoopSigner(w.me), destination: key(2), amount: lamports(500_000n) }), m),
                        (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: createNoopSigner(w.me), destination: key(2), amount: lamports(500_000n) }), m),
                    ),
                ),
            ),
        ),
    );
    result(await own(bytes(twice), w.me, key(2), w.shell));
    const shown = w.approvals[0];
    assert.ok(shown.kind === 'transaction' && shown.guards.held, 'guarded');
    assert.ok((await decode(w.sent[0])).message.staticAccounts.includes(LIGHTHOUSE));
});


test('shown as reviewed at once, then as prepared: no verdict, fee, guards or hash before, and only the final form is answered', async () => {
    const w = await wallet({ key: true });
    await w.call('signTransaction', { account: w.me, transactions: [w.transfer()] });
    const [first] = w.firsts;
    const [final] = w.approvals;
    assert.ok(first.kind === 'transaction' && final.kind === 'transaction');
    assert.equal(first.preparing, true);
    assert.deepEqual([first.hash, first.fee, first.guards.text, first.added], ['', '', '', []]);
    assert.ok(!first.balances.some((b) => b.lines.some((l) => l.note.includes('fee'))), 'no fee guessed');
    assert.ok(first.balances.length > 0, 'the balances, as reviewed');
    assert.equal(final.preparing, undefined);
    assert.ok(final.hash && final.fee && final.guards.held);
});

test('a transfer built in Send without a blockhash is sent with the one the network gave, as its final form shows it', async () => {
    for (const version of [0, 1] as const) {
        const w = await wallet({ key: true });
        const unset = { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 0n };
        const built = await sendTransfer(w.me, { kind: 'wallet', address: key(2) }, { kind: 'sol' }, 1_000_000n, unset, version);
        result(await own(built, w.me, key(2), w.shell));
        const sent = await decode(w.sent[0]);
        assert.equal(sent.message.lifetimeToken, key(99), `v${version}: the network's blockhash`);
        const final = w.approvals[0];
        assert.ok(final.kind === 'transaction' && final.hash.replaceAll(' ', '') === sent.hash, `v${version}: the hash shown is the one sent`);
        const signature = getTransactionDecoder().decode(w.sent[0]).signatures[w.me]!;
        assert.ok(await verifySignature(w.pair.publicKey, signature, sent.messageBytes));
    }
});

test('a transfer made in the popup shows after two round trips (blockhash with the review), prepared after two more', async () => {
    const RTT = 60;
    const w = await wallet({ key: true, slow: RTT });
    const start = performance.now();
    result(await own(bytes(w.transfer()), w.me, key(2), w.shell));
    const first = w.shownAt.first[0] - start;
    const final = w.shownAt.final[0] - start;
    // The review: the accounts, then their simulation (the blockhash and the deploy dates read meanwhile).
    assert.ok(first >= 2 * RTT && first < 3 * RTT, `shown after ${Math.round(first)} ms`);
    // Prepared: the limit measured with the price asked meanwhile, then the transaction as signed simulated.
    assert.ok(final - first >= 2 * RTT && final - first < 3.5 * RTT, `prepared ${Math.round(final - first)} ms later`);
});


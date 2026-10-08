import assert from 'node:assert/strict';
import { test } from 'node:test';

import { intake } from '../src/intake.ts';
import { Refused } from '../src/protocol.ts';
import { key, transfer } from './helpers.ts';

const ORIGIN = 'https://jup.ag';
const ACCOUNT = key(1);
const tx = { method: 'signTransaction', params: { account: ACCOUNT, transactions: ['AQID'] } };
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

test('turns calls into requests', () => {
    assert.deepEqual(intake(tx, ORIGIN), {
        kind: 'transaction',
        origin: ORIGIN,
        account: ACCOUNT,
        chain: null,
        send: false,
        transactions: [new Uint8Array([1, 2, 3])],
    });
    assert.deepEqual(intake({ method: 'connect' }, ORIGIN), { kind: 'connect', origin: ORIGIN, silent: false });
    const big = { ...tx, params: { ...tx.params, chain: 'solana:localnet', transactions: [b64(new Uint8Array(4096))] } };
    assert.equal(intake(big, 'http://localhost:3000').kind, 'transaction');
});

test('a sign-in is bound to the site that asks for it', () => {
    const signIn = (params: object) => intake({ method: 'signIn', params }, ORIGIN);
    assert.deepEqual(signIn({ statement: 'Hello', resources: [], extra: 'dropped' }), {
        kind: 'signIn',
        origin: ORIGIN,
        input: { statement: 'Hello', resources: [], domain: 'jup.ag' },
    });
    assert.equal(signIn({ domain: 'jup.ag', uri: 'https://jup.ag/login' }).kind, 'signIn');
    assert.throws(() => signIn({ domain: 'JUP.ag' }), Refused); // the site could not check what Otus signs
    assert.throws(() => signIn({ domain: 'evil.example' }), Refused);
    assert.throws(() => signIn({ uri: 'https://evil.example/login' }), Refused);
});

test('refuses what a site should not send', () => {
    const p = tx.params;
    const cases: [string, unknown][] = [
        ['not an object', 'hello'],
        ['unknown method', { method: 'drain' }],
        ['bad account', { ...tx, params: { ...p, account: 'nope' } }],
        ['bad base64', { ...tx, params: { ...p, transactions: ['AQID!'] } }],
        ['no transactions', { ...tx, params: { ...p, transactions: [] } }],
        ['too many transactions', { ...tx, params: { ...p, transactions: Array(33).fill('AQID') } }],
        ['transaction too large', { ...tx, params: { ...p, transactions: [b64(new Uint8Array(4097))] } }],
        ['unknown chain', { ...tx, params: { ...p, chain: 'ethereum:1' } }],
        ['newline in a sign-in field', { method: 'signIn', params: { statement: 'Hi\nURI: https://evil.example' } }],
        ['line separator in a sign-in field', { method: 'signIn', params: { statement: 'Hi URI: https://evil.example' } }],
        ['zero-width space in a sign-in field', { method: 'signIn', params: { statement: 'jup​.ag' } }],
        ['a transaction message to sign as a message', { method: 'signMessage', params: { account: ACCOUNT, message: b64(transfer().subarray(65)) } }],
    ];
    for (const [name, call] of cases) assert.throws(() => intake(call, ORIGIN), Refused, name);
    for (const origin of ['http://jup.ag', 'https://jup.ag/path', 'nope']) {
        assert.throws(() => intake(tx, origin), Refused, origin);
    }
});

test('a message that reads as a sign-in for another site is refused', () => {
    const message = (text: string) => intake({ method: 'signMessage', params: { account: key(1), message: Buffer.from(text).toString('base64') } }, ORIGIN);
    const signIn = (domain: string, rest = '') => `${domain} wants you to sign in with your Solana account:\n${key(1)}${rest}`;
    assert.throws(() => message(signIn('bank.example')), Refused);
    for (const br of ['\r\n', '\r', '\u2028']) assert.throws(() => message(signIn('bank.example').replace('\n', br)), Refused); // other line breaks
    assert.throws(() => message(signIn('jup.ag', '\n\nURI: https://bank.example')), Refused);
    assert.equal(message(signIn('jup.ag', '\n\nURI: https://jup.ag/login')).kind, 'message');
    assert.equal(message('Sign in to jup.ag, please').kind, 'message');
    // Anywhere in it: after a line of its own, far below, after the site's own sign-in, behind other line breaks.
    for (const hidden of [`Please confirm:\n${signIn('bank.example')}`, `\n${signIn('bank.example')}`, `${'\n'.repeat(3000)}${signIn('bank.example')}`, `${signIn('jup.ag')}\n\n${signIn('bank.example')}`, signIn('bank.example').replace('\n', '\v')]) {
        assert.throws(() => message(hidden), Refused, JSON.stringify(hidden.slice(0, 40)));
    }
    // An off-chain message is refused; binary that is no transaction, as a random challenge, is signed.
    const raw = (b: number[]) => intake({ method: 'signMessage', params: { account: key(1), message: Buffer.from(b).toString('base64') } }, ORIGIN);
    assert.throws(() => raw([0xff, ...Buffer.from('solana offchain'), 1, 1]), Refused);
    for (const first of [0x80, 0x81, 0xbf]) assert.equal(raw([first, ...new Uint8Array(31).fill(7)]).kind, 'message');
    // A sign-in whose statement holds another.
    const signInCall = (statement: string) => intake({ method: 'signIn', params: { statement } }, ORIGIN);
    assert.throws(() => signInCall('bank.example wants you to sign in with your Solana account'), Refused);
    assert.equal(signInCall('Welcome back').kind, 'signIn');
});

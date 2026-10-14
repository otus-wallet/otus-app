import assert from 'node:assert/strict';
import { test } from 'node:test';

import { passwordProblem, strength } from '../src/password.ts';

test('a new password: 8 to 32 characters, typed the same twice', () => {
    assert.equal(passwordProblem('short', 'short'), 'Use a password of 8 to 32 characters');
    assert.equal(passwordProblem('x'.repeat(33), 'x'.repeat(33)), 'Use a password of 8 to 32 characters');
    assert.equal(passwordProblem('long enough', 'long enougH'), 'The two passwords differ');
    assert.equal(passwordProblem('x'.repeat(32), 'x'.repeat(32)), null);
    assert.equal(passwordProblem('ñandú-ñandú', 'ñandú-ñandú'), null);
    assert.equal(passwordProblem('🔑🔑🔑🔑🔑🔑🔑🔑', '🔑🔑🔑🔑🔑🔑🔑🔑'), null); // characters, not code units
});

test('how hard a password is to guess: what is tried first is weak, long and varied is strong', () => {
    for (const p of ['12345678', 'abcdefgh', 'qwertyui', 'aaaaaaaa', 'password1', 'Password123', 'iloveyou2026', 'asdfghjkl;', 'solana2026']) assert.equal(strength(p), 'weak', p);
    for (const p of ['kD9#mq2!', 'mountainriver', 'Bk7pq2Lx9w']) assert.equal(strength(p), 'fair', p);
    for (const p of ['correct horse battery', 'kD9#mq2!xL4@', 'Tr0ub4dor&3x', 'vjqmzpbkxfnhgt']) assert.equal(strength(p), 'strong', p);
});

test('a password is measured as its key is made from it: compatibility forms folded', () => {
    assert.equal(passwordProblem('e\u0301'.repeat(4), 'e\u0301'.repeat(4)), 'Use a password of 8 to 32 characters'); // four é
    assert.equal(strength('ＰＡＳＳＷＯＲＤ１２'), 'weak'); // PASSWORD12
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createKeyPairFromPrivateKeyBytes, getAddressEncoder, getAddressFromPublicKey, getBase58Decoder } from '@solana/kit';

import { newPhrase, phraseOf, privateKeyFromText, privateKeyOf } from '../src/keys/derive.ts';
import { createVault, openVault, readSecrets, writeSecrets, WrongPassword, type Secret } from '../src/keys/vault.ts';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const CHEAP = { t: 1, m: 256, p: 1 }; // Argon2id costs small enough for tests

const addressOf = async (privateKey: Uint8Array) => getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(privateKey)).publicKey);

test('derives accounts as solana-keygen, Phantom and Solflare do: m/44\'/501\'/i\'/0\'', async () => {
    // From `solana-keygen pubkey "prompt://?key=0/0"` and "key=1/0" with this phrase.
    assert.equal(await addressOf(await privateKeyOf(ABANDON, 0)), 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
    assert.equal(await addressOf(await privateKeyOf(ABANDON, 1)), 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb');
    await assert.rejects(privateKeyOf(ABANDON, -1));
    await assert.rejects(privateKeyOf(ABANDON, 2 ** 31));
});

test('reads a phrase as typed, and refuses one that is not valid', () => {
    assert.equal(phraseOf(`  ${ABANDON.toUpperCase().replaceAll(' ', ' \n ')}  `), ABANDON);
    assert.equal(phraseOf(ABANDON.replace('about', 'abandon')), null); // checksum
    assert.equal(phraseOf(ABANDON.replace('about', 'otus')), null); // not a word
    assert.equal(phraseOf('abandon about'), null);
    const fresh = newPhrase();
    assert.equal(fresh.split(' ').length, 12);
    assert.equal(phraseOf(fresh), fresh);
});

test('the vault opens with its password only, and keeps its secrets', async () => {
    const secrets: Secret[] = [{ id: 'a', phrase: ABANDON }];
    const { vault, key } = await createVault('correct horse', secrets, CHEAP);
    assert.deepEqual(await readSecrets(vault, key), secrets);
    assert.deepEqual(await openVault(vault, 'correct horse'), key);
    assert.deepEqual(await openVault(vault, 'correct horse'.normalize('NFD')), key);
    await assert.rejects(openVault(vault, 'correct horse '), WrongPassword);

    const more = await writeSecrets(vault, key, [...secrets, { id: 'b', key: 'AAAA' }]);
    assert.equal((await readSecrets(more, key)).length, 2);
    assert.notEqual(more.secrets.iv, vault.secrets.iv);
    assert.deepEqual(await openVault(more, 'correct horse'), key);
});

test('a vault part cannot be swapped for another or changed', async () => {
    const { vault, key } = await createVault('correct horse', [], CHEAP);
    await assert.rejects(readSecrets({ ...vault, secrets: vault.key }, key));
    await assert.rejects(openVault({ ...vault, key: vault.secrets }, 'correct horse'), WrongPassword);
    const flipped = vault.secrets.data.startsWith('A') ? `B${vault.secrets.data.slice(1)}` : `A${vault.secrets.data.slice(1)}`;
    await assert.rejects(readSecrets({ ...vault, secrets: { ...vault.secrets, data: flipped } }, key));
    await assert.rejects(openVault({ ...vault, kdf: { ...vault.kdf, t: 2 } }, 'correct horse'), WrongPassword);
});

test('takes a private key as wallets export it, and never an address in its place', async () => {
    const privateKey = await privateKeyOf(ABANDON, 0);
    const address = await addressOf(privateKey);
    const pair = new Uint8Array([...privateKey, ...getAddressEncoder().encode(address)]);
    assert.deepEqual(await privateKeyFromText(` ${getBase58Decoder().decode(pair)} `), privateKey); // Phantom, Solflare
    assert.deepEqual(await privateKeyFromText(JSON.stringify([...pair])), privateKey); // solana-keygen
    assert.equal(await privateKeyFromText(address), null); // 32 bytes: an address pasted by mistake
    assert.equal(await privateKeyFromText(getBase58Decoder().decode(privateKey)), null);
    const other = new Uint8Array([...privateKey, ...getAddressEncoder().encode('Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb' as never)]);
    assert.equal(await privateKeyFromText(getBase58Decoder().decode(other)), null); // key and public key do not match
    assert.equal(await privateKeyFromText('[1, 2, 300]'), null);
    assert.equal(await privateKeyFromText('not a key'), null);
});

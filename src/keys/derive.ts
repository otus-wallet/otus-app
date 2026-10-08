// Recovery phrases (BIP39) and the accounts on them, derived as Phantom, Solflare and Backpack derive them.
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { createKeyPairFromBytes, getBase58Encoder } from '@solana/kit';

/** A new phrase: 12 words from 128 random bits, or 24 from 256. */
export const newPhrase = (words: 12 | 24 = 12) => generateMnemonic(wordlist, words === 24 ? 256 : 128);

/** Words as typed → the phrase, lowercase and single-spaced; null when it is not a valid English phrase. */
export function phraseOf(text: string): string | null {
    const phrase = text.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
    return validateMnemonic(phrase, wordlist) ? phrase : null;
}

/** The private key of account `index` on a phrase: SLIP-0010 Ed25519 at m/44'/501'/index'/0'. */
export async function privateKeyOf(phrase: string, index: number): Promise<Uint8Array> {
    if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) throw new Error('bad account index');
    const seed = await mnemonicToSeed(phrase);
    try {
        return slip10(seed, [44, 501, index, 0]);
    } finally {
        seed.fill(0);
    }
}

/** The private keys of accounts 0 to `count` − 1 on a phrase, from one seed. */
export async function privateKeysOf(phrase: string, count: number): Promise<Uint8Array[]> {
    const seed = await mnemonicToSeed(phrase);
    try {
        return Array.from({ length: count }, (_, index) => slip10(seed, [44, 501, index, 0]));
    } finally {
        seed.fill(0);
    }
}

// SLIP-0010 for Ed25519, which has hardened steps only: each step is HMAC-SHA512 of 0x00, the key and the index.
function slip10(seed: Uint8Array, path: number[]): Uint8Array {
    let node = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed);
    for (const step of path) {
        const data = new Uint8Array(37);
        data.set(node.subarray(0, 32), 1);
        new DataView(data.buffer).setUint32(33, (step | 0x80000000) >>> 0);
        const child = hmac(sha512, node.subarray(32), data);
        node.fill(0);
        data.fill(0);
        node = child;
    }
    const key = node.slice(0, 32);
    node.fill(0);
    return key;
}

/**
 * A private key as wallets export it, base58 (Phantom, Solflare, Backpack) or a JSON list of numbers (solana-keygen):
 * the 64 bytes of key and public key, checked against each other → the 32 bytes of the key; null when it is not one.
 * Never 32 bytes alone: an address pasted by mistake would pass as a key that anyone can rebuild.
 */
export async function privateKeyFromText(text: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const t = text.trim();
    let b: Uint8Array;
    try {
        const list: unknown = t.startsWith('[') ? JSON.parse(t) : null;
        if (list !== null && !(Array.isArray(list) && list.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))) return null;
        b = list ? Uint8Array.from(list as number[]) : new Uint8Array(getBase58Encoder().encode(t));
    } catch {
        return null;
    }
    try {
        if (b.length !== 64 || !(await createKeyPairFromBytes(b).then(() => true, () => false))) return null;
        return new Uint8Array(b.subarray(0, 32));
    } finally {
        b.fill(0);
    }
}

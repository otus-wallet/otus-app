// The vault: your phrases and keys, sealed with a random key; your password, through Argon2id, seals that key.
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { getBase64Decoder, getBase64Encoder } from '@solana/kit';

/** A recovery phrase, or a private key imported on its own (32 bytes, base64). */
export type Secret = { id: string; phrase: string } | { id: string; key: string };

/** AES-256-GCM output and its nonce, in base64. */
export type Sealed = { iv: string; data: string };

/** Argon2id's salt (base64) and costs: passes, memory in KiB, lanes. */
export type Kdf = { salt: string; t: number; m: number; p: number };

export type Vault = {
    version: 1;
    kdf: Kdf;
    key: Sealed; // the vault key, sealed with the password's
    secrets: Sealed; // Secret[] as JSON, sealed with the vault key
};

// RFC 9106's second recommendation with one lane, as JavaScript runs one: about 0.6 s on a laptop.
export const COSTS = { t: 3, m: 64 * 1024, p: 1 };

export class WrongPassword extends Error {}
/** A vault Otus can't read: not as it writes one. */
export class UnknownVault extends Error {}

/** Bytes WebCrypto takes. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** A new vault holding these secrets → it, and its key to keep while unlocked. */
export async function createVault(password: string, secrets: Secret[], costs = COSTS): Promise<{ vault: Vault; key: Bytes }> {
    const kdf = { salt: base64(random(16)), ...costs };
    const key = random(32);
    const vault: Vault = { version: 1, kdf, key: await seal(await passwordKey(password, kdf), key, 'key'), secrets: await seal(key, json(secrets), 'secrets') };
    return { vault, key };
}

/** The vault's key, given its password. Throws WrongPassword, or UnknownVault for one not as Otus writes it. */
export async function openVault(vault: Vault, password: string): Promise<Bytes> {
    if (!asWritten(vault)) throw new UnknownVault('not a vault Otus made');
    const sealer = await passwordKey(password, vault.kdf);
    try {
        return await open(sealer, vault.key, 'key');
    } catch {
        throw new WrongPassword('Wrong password');
    } finally {
        sealer.fill(0);
    }
}

export const readSecrets = async (vault: Vault, key: Bytes): Promise<Secret[]> => JSON.parse(new TextDecoder().decode(await open(key, vault.secrets, 'secrets')));

export const writeSecrets = async (vault: Vault, key: Bytes, secrets: Secret[]): Promise<Vault> => ({ ...vault, secrets: await seal(key, json(secrets), 'secrets') });

// A vault as Otus writes it: its version, a 16-byte salt and costs no higher than Otus's own, and a 12-byte nonce for each
// part. Costs past them, written by anything but Otus, would hold the keystore for as long as they say.
function asWritten(v: Vault): boolean {
    const within = (n: unknown, low: number, high: number) => Number.isInteger(n) && (n as number) >= low && (n as number) <= high;
    const length = (b64: unknown) => {
        try {
            return typeof b64 === 'string' ? bytes(b64).length : -1;
        } catch {
            return -1;
        }
    };
    const sealed = (s: Sealed | undefined) => length(s?.iv) === 12 && typeof s?.data === 'string';
    const k = v?.kdf;
    return v?.version === 1 && length(k?.salt) === 16 && within(k.t, 1, COSTS.t) && within(k.p, 1, COSTS.p) && within(k.m, 8 * k.p, COSTS.m) && sealed(v.key) && sealed(v.secrets);
}

// The same password typed on another keyboard, or composed another way, gives the same key.
const passwordKey = (password: string, kdf: Kdf) => argon2idAsync(password.normalize('NFKC'), bytes(kdf.salt), { t: kdf.t, m: kdf.m, p: kdf.p, dkLen: 32, maxmem: COSTS.m * 1024 });

// Each sealed part names what it holds, so one cannot stand in for the other.
async function seal(key: Bytes, data: Bytes, what: string): Promise<Sealed> {
    const iv = random(12);
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: label(what) }, await aes(key), data);
    return { iv: base64(iv), data: base64(new Uint8Array(sealed)) };
}

async function open(key: Bytes, sealed: Sealed, what: string): Promise<Bytes> {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(sealed.iv), additionalData: label(what) }, await aes(key), bytes(sealed.data)));
}

const aes = (key: Bytes) => crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
const label = (what: string) => new TextEncoder().encode(`otus vault 1 ${what}`);
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const base64 = (b: Uint8Array) => getBase64Decoder().decode(b);
export const bytes = (s: string) => new Uint8Array(getBase64Encoder().encode(s));

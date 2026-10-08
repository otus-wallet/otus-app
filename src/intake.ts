import { getBase64Encoder, getCompiledTransactionMessageDecoder, isAddress, type Address } from '@solana/kit';

import { Refused, SIGN_IN_FIELDS, type SignInInput } from './protocol.ts';

export const CHAINS = ['solana:mainnet', 'solana:devnet', 'solana:testnet', 'solana:localnet'] as const;
export type Cluster = (typeof CHAINS)[number];

// transactionBytes is the v1 limit; decode holds legacy and v0 to 1232.
export const LIMITS = { transactions: 32, transactionBytes: 4096, messageBytes: 4096, text: 512, resources: 16 };

/** A site's call after intake. `origin` comes from the browser, never from the page. */
export type Request =
    | { kind: 'connect'; origin: string; silent: boolean }
    | { kind: 'disconnect'; origin: string }
    | { kind: 'transaction'; origin: string; account: Address; chain: Cluster | null; send: boolean; transactions: Uint8Array[] }
    | { kind: 'message'; origin: string; account: Address; message: Uint8Array }
    | { kind: 'signIn'; origin: string; input: SignInInput };

/** Untrusted call → Request. Throws Refused. */
export function intake(call: unknown, origin: string): Request {
    checkOrigin(origin);
    const { method, params } = record(call, 'call');
    const p = params === undefined ? {} : record(params, 'params');
    switch (method) {
        case 'connect':
            return { kind: 'connect', origin, silent: p.silent === true };
        case 'disconnect':
            return { kind: 'disconnect', origin };
        case 'signTransaction':
        case 'signAndSendTransaction':
            return {
                kind: 'transaction',
                origin,
                account: account(p.account),
                chain: chain(p.chain),
                send: method === 'signAndSendTransaction',
                transactions: list(p.transactions, 'transactions', LIMITS.transactions).map((t) =>
                    bytes(t, 'transaction', LIMITS.transactionBytes),
                ),
            };
        case 'signMessage':
            return { kind: 'message', origin, account: account(p.account), message: message(p.message, origin) };
        case 'signIn':
            return { kind: 'signIn', origin, input: signIn(p, origin) };
        default:
            throw new Refused('unknown method');
    }
}

// A site may only ask for a sign-in to itself.
function signIn(p: Record<string, unknown>, origin: string): SignInInput {
    const input: SignInInput = {};
    for (const key of SIGN_IN_FIELDS) {
        if (p[key] !== undefined) input[key] = text(p[key], key);
    }
    if (p.resources !== undefined) {
        input.resources = list(p.resources, 'resources', LIMITS.resources, 0).map((r) => text(r, 'resource'));
    }
    if (input.address !== undefined && !isAddress(input.address)) throw new Refused('bad address');
    const host = new URL(origin).host;
    if (input.domain !== undefined && input.domain !== host) throw new Refused('sign-in domain is not this site');
    if (input.uri !== undefined && !sameOrigin(input.uri, origin)) throw new Refused('sign-in uri is not this site');
    if ([input.statement, ...(input.resources ?? [])].some((t) => t?.includes(SIGN_IN))) throw new Refused('a sign-in inside a sign-in');
    return { ...input, domain: host };
}

// What every Sign In With Solana message says after the site's domain.
const SIGN_IN = ' wants you to sign in with your Solana account';
// Solana's off-chain messages start so; Otus signs none (it offers no off-chain signing), and one could carry a sign-in.
const OFFCHAIN = [0xff, ...new TextEncoder().encode('solana offchain')];

// Bytes that parse as a transaction message would give the site a transaction signature; an off-chain message could
// carry anything. Text that reads as Sign In With Solana, anywhere in it, must be this site's own, whole: its domain
// first, once, and every URI this site's.
function message(v: unknown, origin: string): Uint8Array {
    const m = bytes(v, 'message', LIMITS.messageBytes);
    let parsed = false;
    try {
        parsed = getCompiledTransactionMessageDecoder().read(m, 0)[1] === m.length;
    } catch {}
    if (parsed) throw new Refused('message is a transaction');
    if (OFFCHAIN.every((b, i) => m[i] === b)) throw new Refused('message is an off-chain message');
    const text = new TextDecoder().decode(m).replace(/\r\n?|[\u0085\u2028\u2029\v\f]/g, '\n'); // any line break, as a reader may take it
    const at = text.indexOf(SIGN_IN);
    if (at < 0) return m;
    const own = text.startsWith(`${new URL(origin).host}${SIGN_IN}:\n`) && !text.includes(SIGN_IN, at + 1);
    if (!own || [...text.matchAll(/\nURI: ([^\n]*)/g)].some(([, uri]) => !sameOrigin(uri, origin))) throw new Refused('message signs you in to another site');
    return m;
}

function checkOrigin(origin: string) {
    let url: URL;
    try {
        url = new URL(origin);
    } catch {
        throw new Refused('bad origin');
    }
    const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (url.origin !== origin || (url.protocol !== 'https:' && !local)) throw new Refused('origin must be https');
}

function sameOrigin(uri: string, origin: string): boolean {
    try {
        return new URL(uri).origin === origin;
    } catch {
        return false;
    }
}

function record(v: unknown, what: string): Record<string, unknown> {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Refused(`${what} must be an object`);
    return v as Record<string, unknown>;
}

function list(v: unknown, what: string, max: number, min = 1): unknown[] {
    if (!Array.isArray(v) || v.length < min || v.length > max) throw new Refused(`${what}: ${min} to ${max} items`);
    return v;
}

// Control, invisible and line-breaking characters could forge or hide lines of a sign-in message.
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function text(v: unknown, what: string): string {
    if (typeof v !== 'string' || v.length > LIMITS.text || UNSAFE_TEXT.test(v) || !v.isWellFormed()) {
        throw new Refused(`bad ${what}`);
    }
    return v;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function bytes(v: unknown, what: string, max: number): Uint8Array {
    const ok = typeof v === 'string' && v.length > 0 && v.length <= Math.ceil(max / 3) * 4 && BASE64.test(v);
    if (!ok) throw new Refused(`${what} must be base64, up to ${max} bytes`);
    const out = new Uint8Array(getBase64Encoder().encode(v));
    if (out.length > max) throw new Refused(`${what} over ${max} bytes`);
    return out;
}

function account(v: unknown): Address {
    if (typeof v !== 'string' || !isAddress(v)) throw new Refused('bad account');
    return v;
}

function chain(v: unknown): Cluster | null {
    if (v === undefined || v === null) return null;
    const found = CHAINS.find((c) => c === v);
    if (found === undefined) throw new Refused('unknown chain');
    return found;
}

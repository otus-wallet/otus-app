/** A site's call as the background receives it. Extension messaging is JSON, so bytes travel as base64. */
export type Call =
    | { method: 'connect'; params?: { silent?: boolean } }
    | { method: 'disconnect'; params?: Record<string, never> }
    | { method: 'signTransaction' | 'signAndSendTransaction'; params: { account: string; chain?: string; transactions: string[] } }
    | { method: 'signMessage'; params: { account: string; message: string } }
    | { method: 'signIn'; params: SignInInput };

/** Sign In With Solana fields, in the order its message writes them, and as the site proposes them. */
export const SIGN_IN_FIELDS = ['domain', 'address', 'statement', 'uri', 'version', 'chainId', 'nonce', 'issuedAt', 'expirationTime', 'notBefore', 'requestId'] as const;
export type SignInField = (typeof SIGN_IN_FIELDS)[number];
export type SignInInput = Partial<Record<SignInField, string>> & { resources?: string[] };

/** The background's answer, handed back to the site. `rejected`: the user said no. */
export type Reply = { ok: true; result: unknown } | { ok: false; error: string; rejected?: boolean };

/** What the page script and the content script say to each other on window.postMessage. */
export const CHANNEL = 'otus';
export type PageMessage =
    | { channel: typeof CHANNEL; kind: 'request'; id: number; call: Call }
    | { channel: typeof CHANNEL; kind: 'response'; id: number; reply: Reply }
    | { channel: typeof CHANNEL; kind: 'accounts'; accounts: string[]; v1: boolean }; // the site's accounts changed in Otus; v1: whether they can sign v1

/** A call refused before review: malformed, too large or not allowed. */
export { Refused } from '@otus-wallet/sdk/errors';

export const NO_KEY = 'Otus holds no key for this account';

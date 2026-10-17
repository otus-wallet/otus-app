// The terms of use the popup asks to accept once, over the wallet: their version, raised only when they change in a way
// that matters, so each user is asked again; and where they are in full.

export const TERMS = 1;
export const TERMS_URL = 'https://otus.sh/terms';

/** The terms as accepted: their version, and when (seconds since 1970). */
export type Accepted = { version: number; at: number };

/** Whether what is stored says the current terms were accepted. */
export function accepted(stored: unknown): boolean {
    const version = (stored as Partial<Accepted> | null | undefined)?.version;
    return typeof version === 'number' && version >= TERMS;
}

/** The current terms, accepted now. */
export const accepting = (now = Date.now()): Accepted => ({ version: TERMS, at: Math.floor(now / 1000) });

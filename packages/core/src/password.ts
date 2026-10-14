// A new password: how long it may be, and how hard it is to guess, as the setup and Settings show it.

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 32;

/** Why a new password, typed twice, can't be used; null when it can. */
export function passwordProblem(first: string, again: string): string | null {
    const length = [...first].length;
    if (length < MIN_PASSWORD || length > MAX_PASSWORD) return `Use a password of ${MIN_PASSWORD} to ${MAX_PASSWORD} characters`;
    if (first !== again) return 'The two passwords differ';
    return null;
}

export type Strength = 'weak' | 'fair' | 'strong';

// Rows of the keyboard, and the digits: a character beside the one before it there is guessed with it.
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];
// Words tried first, whole or as part of a password.
const COMMON = ['password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'iloveyou', 'admin', 'login', 'monkey', 'dragon', 'master', 'shadow', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'batman', 'trustno', 'secret', 'solana', 'phantom', 'bitcoin', 'crypto', 'wallet', 'otus'];

/**
 * About how hard a password is to guess: its length over the characters it draws from, as bits, where a character
 * guessed with the one before it (the same again, the next in the alphabet or a run of digits, its neighbour on the
 * keyboard) counts for a quarter, and a word tried first counts as one guess among a thousand. Weak under 40 bits,
 * strong from 60.
 */
export function strength(password: string): Strength {
    const pool = (/[a-z]/.test(password) ? 26 : 0) + (/[A-Z]/.test(password) ? 26 : 0) + (/\d/.test(password) ? 10 : 0) + (/[^a-zA-Z\d]/.test(password) ? 33 : 0);
    // The words tried first taken out, each a gap where it was.
    let rest = password.toLowerCase();
    let words = 0;
    for (const w of COMMON) {
        if (!rest.includes(w)) continue;
        rest = rest.replace(w, '\0');
        words++;
    }
    const chars = [...rest];
    let counted = 0;
    chars.forEach((c, i) => {
        if (c === '\0') return;
        counted += i > 0 && chars[i - 1] !== '\0' && follows(chars[i - 1], c) ? 0.25 : 1;
    });
    const bits = counted * Math.log2(Math.max(pool, 2)) + words * Math.log2(1000);
    if (bits < 40) return 'weak';
    return bits < 60 ? 'fair' : 'strong';
}

// Whether a character is guessed with the one before it: the same, the next or the one before in order, or beside it
// on a row of the keyboard.
function follows(before: string, c: string): boolean {
    const [a, b] = [before.codePointAt(0)!, c.codePointAt(0)!];
    if (Math.abs(a - b) <= 1) return true;
    return ROWS.some((row) => {
        const [i, j] = [row.indexOf(before), row.indexOf(c)];
        return i >= 0 && j >= 0 && Math.abs(i - j) === 1;
    });
}

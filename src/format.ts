// Numbers and addresses as people read them. Pure, for the review and the pages alike.

/** An address in short: its first and last four characters. */
export const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Base units as a decimal, digits grouped and trailing zeros dropped, with its sign when asked: −1500000000, 9 → "−1.5". */
export function amount(units: bigint, decimals: number, signed = true): string {
    const abs = units < 0n ? -units : units;
    const scale = 10n ** BigInt(decimals);
    const fraction = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
    const sign = !signed ? '' : units < 0n ? '−' : units > 0n ? '+' : '';
    return `${sign}${(abs / scale).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
}

export const SOL_DECIMALS = 9;

/** Lamports as SOL, without a sign. */
export const sol = (lamports: bigint) => amount(lamports, SOL_DECIMALS, false);

/** Base units as a signed decimal, or as raw units when the decimals are not known. */
export const quantity = (units: bigint, decimals: number | null) => (decimals === null ? `${units} units` : amount(units, decimals));

/** A count and its word: "1 signature", "3 signatures". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The first letter up. */
// Only a plain first word ("you", "your", "an"): an address, cut short or whole, is never changed.
export const cap = (s: string) => (/^[a-z]{1,12}(\s|$)/.test(s) ? s[0].toUpperCase() + s.slice(1) : s);

/** Text a program or a node wrote, shown as written: without characters that move or hide others, and kept short. */
export const told = (s: string, max = 120) => {
    const shown = [...s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim()];
    return shown.length > max ? `${shown.slice(0, max - 1).join('')}…` : shown.join('');
};

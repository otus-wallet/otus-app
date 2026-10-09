// Token names, logos and prices from Jupiter's token search, for the popup's balances and the review's lines: through
// Otus's server when mainnet is read through it (Jupiter then learns what Otus asks, not who), else from Jupiter
// itself, keyless, so that a wallet on an RPC of its own asks Otus's server nothing. Each token is asked once while the
// page or worker lives.
import { latin } from '@otus-wallet/sdk/review/sites';

import { OTUS_RPC } from './settings.ts';

export type TokenInfo = { id: string; name: string; symbol: string; icon: string | null; verified: boolean; usdPrice: number | null; change24h: number | null; decimals: number | null }; // change24h: percent

const THROUGH_OTUS = `${OTUS_RPC}/tokens`;
const JUPITER = 'https://api.jup.ag/tokens/v2/search';
const PER_SEARCH = 100; // mints in one search
const WAIT = 8_000; // ms for Jupiter to answer, after which the tokens go without

const looked = new Map<string, TokenInfo | null>(); // null: Jupiter does not know it

/** What Jupiter says of these mints, through Otus's server or not; an empty answer for those it does not know, or
 *  when it does not answer. */
export async function tokens(mints: string[], throughOtus: boolean): Promise<Map<string, TokenInfo | null>> {
    const asking = [...new Set(mints)].filter((m) => !looked.has(m));
    try {
        for (let i = 0; i < asking.length; i += PER_SEARCH) {
            const batch = asking.slice(i, i + PER_SEARCH);
            const response = await fetch(`${throughOtus ? THROUGH_OTUS : JUPITER}?query=${batch.join(',')}`, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(WAIT) });
            if (!response.ok) throw new Error(`Jupiter answered ${response.status}`);
            const found = new Map((await response.json() as unknown[]).flatMap((t) => (info(t) ? [[info(t)!.id, info(t)!] as const] : [])));
            for (const m of batch) looked.set(m, found.get(m) ?? null);
        }
    } catch {} // no names or prices beats no balances
    return new Map([...new Set(mints)].map((m) => [m, looked.get(m) ?? null]));
}

/** What Jupiter said of a mint already, this page or worker: no request. */
export const cachedToken = (mint: string): TokenInfo | null => looked.get(mint) ?? null;

// One of Jupiter's answers, read with care: its names come from token makers.
function info(t: unknown): TokenInfo | null {
    const v = t as { id?: unknown; name?: unknown; symbol?: unknown; icon?: unknown; isVerified?: unknown; usdPrice?: unknown; decimals?: unknown; stats24h?: { priceChange?: unknown } };
    if (typeof v?.id !== 'string') return null;
    return {
        id: v.id,
        name: clean(v.name),
        symbol: clean(v.symbol),
        icon: typeof v.icon === 'string' && v.icon.startsWith('https://') ? v.icon : null,
        verified: v.isVerified === true && !forged(v.id, clean(v.symbol)),
        usdPrice: finite(v.usdPrice),
        change24h: finite(v.stats24h?.priceChange),
        decimals: Number.isInteger(v.decimals) && (v.decimals as number) >= 0 && (v.decimals as number) <= 255 ? (v.decimals as number) : null, // a mint keeps them in one byte
    };
}

// The real mints of the symbols scams like most to borrow, checked with Jupiter: a token by one of these
// names at another address is not verified, whatever an answer says of it.
const REAL: Record<string, string> = {
    SOL: 'So11111111111111111111111111111111111111112',
    WSOL: 'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    JTO: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
    PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    MSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    JITOSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    BSOL: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
    JUPSOL: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v',
    INF: '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm',
    RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    ORCA: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
    PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
};
const forged = (mint: string, symbol: string) => {
    const read = latin(symbol).toUpperCase();
    return Object.hasOwn(REAL, read) && REAL[read] !== mint;
};

const finite = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

// No control or invisible characters, which could reorder or hide what is shown; and short.
const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 40) : '');

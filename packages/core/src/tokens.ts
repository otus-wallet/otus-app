// Token names, logos and prices from Jupiter's token search, for the popup's balances and the review's lines: through
// Otus's server when mainnet is read through it (Jupiter then learns what Otus asks, not who), else from Jupiter
// itself, keyless, so that a wallet on an RPC of its own asks Otus's server nothing. Each token is asked once while the
// page or worker lives.
import { isAddress } from '@solana/kit';

import { latin } from '@otus-wallet/sdk/review/sites';

import { platform } from './platform.ts';
import { OTUS_RPC } from './settings.ts';

export type TokenInfo = { id: string; name: string; symbol: string; icon: string | null; verified: boolean; usdPrice: number | null; change24h: number | null; decimals: number | null; supply?: Supply | null; market?: Market | null }; // change24h: percent

/** A token's supply as Jupiter counts it, in whole tokens: all of it, and what circulates. */
export type Supply = { total: number; circulating: number };

/** A token's market as Jupiter counts it: what what circulates is worth (dollars), how many hold it, what share its top
 *  holders have (percent), the liquidity of its pools (dollars), and when its first pool opened (ms); each null when not
 *  said. */
export type Market = { cap: number | null; holders: number | null; topHolders: number | null; liquidity: number | null; firstPool: number | null };

const THROUGH_OTUS = `${OTUS_RPC}/tokens`;
const JUPITER = 'https://api.jup.ag/tokens/v2/search';
const PER_SEARCH = 100; // mints in one search
const WAIT = 8_000; // ms for Jupiter to answer, after which the tokens go without

const looked = new Map<string, TokenInfo | null>(); // null: Jupiter does not know it
const asked = new Map<string, Promise<void>>(); // mints asked, until Jupiter answers

// Kept in session storage, by a worker that sleeps when idle and by the popup (keepTokens): each answer as Jupiter gave
// it (null: it does not know the mint), read again with the same care, while fresh; an older one only names a mint.
const KEPT = 'tokens';
const FRESH = 10 * 60_000; // ms an answer is kept: prices age; names hardly
const MOST_KEPT = 300; // answers kept: the latest
type Kept = [mint: string, said: unknown, at: number, throughOtus: boolean];
let kept: Kept[] | null = null; // null: nothing kept
let restored: Promise<void> = Promise.resolve();
let clock = Date.now;
let reused = true; // what was kept answers again while fresh; the popup's own only names (keepTokens)
const fresh = (at: number) => clock() - at >= 0 && clock() - at < FRESH;

/** Keeps what Jupiter says of mints for a while, in session storage, and takes back what was kept fresh before: for a
 *  worker, which starts over each time it wakes. Each answer is used only the way it was asked, through Otus's server
 *  or not, as an icon's host learns who looks otherwise. `now`: ms. `reuse`: false for a page that keeps answers only
 *  for their names (keptName), asking again for prices each time it opens. */
export function keepTokens(now = Date.now, reuse = true): Promise<void> {
    [kept, clock, reused] = [[], now, reuse];
    restored = platform.storage.session.get(KEPT).then(
        (stored) => {
            const list = Array.isArray(stored[KEPT]) ? (stored[KEPT] as unknown[]) : [];
            for (const entry of list) {
                if (!Array.isArray(entry) || entry.length !== 4) continue;
                const [mint, said, at, throughOtus] = entry as Kept;
                if (typeof mint !== 'string' || !isAddress(mint) || typeof at !== 'number' || at > clock() || typeof throughOtus !== 'boolean') continue;
                if (said !== null && info(said)?.id !== mint) continue; // not an answer for this mint
                kept!.push([mint, said, at, throughOtus]);
            }
        },
        () => {}, // nothing kept: asked again
    );
    return restored;
}

// What was kept of these mints, asked this way and fresh still, known again: not asked.
function fromKept(mints: string[], throughOtus: boolean) {
    if (!reused) return;
    for (const [mint, said, at, through] of kept ?? []) {
        if (through !== throughOtus || !fresh(at) || looked.has(mint) || !mints.includes(mint)) continue;
        looked.set(mint, said === null ? null : served(info(said)!, throughOtus));
    }
}

/** What Jupiter says of these mints, through Otus's server or not; an empty answer for those it does not know, or
 *  when it does not answer. A mint asked already, and not answered yet, is waited for rather than asked again: its own
 *  search, not the others asked with it. */
export async function tokens(mints: string[], throughOtus: boolean): Promise<Map<string, TokenInfo | null>> {
    await restored;
    const wanted = [...new Set(mints)];
    fromKept(wanted, throughOtus);
    const asking = wanted.filter((m) => !looked.has(m) && !asked.has(m));
    let before: Promise<void> = Promise.resolve(); // one search after another
    for (let i = 0; i < asking.length; i += PER_SEARCH) {
        const batch = asking.slice(i, i + PER_SEARCH);
        before = before.then(() => ask(batch, throughOtus));
        const answer = before.finally(() => batch.forEach((m) => asked.delete(m)));
        batch.forEach((m) => asked.set(m, answer));
    }
    await Promise.all(wanted.map((m) => asked.get(m)));
    return new Map(wanted.map((m) => [m, looked.get(m) ?? null]));
}

// One search; what it does not answer stays unknown, and is asked again next time.
async function ask(batch: string[], throughOtus: boolean): Promise<void> {
    try {
        const response = await fetch(`${throughOtus ? THROUGH_OTUS : JUPITER}?query=${batch.join(',')}`, { method: methodFor(throughOtus), credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(WAIT) });
        if (!response.ok) throw new Error(`Jupiter answered ${response.status}`);
        const said = new Map((await response.json() as unknown[]).flatMap((t) => (info(t) ? [[info(t)!.id, t] as const] : [])));
        for (const m of batch) looked.set(m, said.has(m) ? served(info(said.get(m))!, throughOtus) : null);
        if (kept) keep(batch.map((m): Kept => [m, said.has(m) ? trimmed(said.get(m)) : null, clock(), throughOtus]));
    } catch {} // no names or prices beats no balances
}

// What is kept of an answer: the fields `info` reads, its words as it reads them, its numbers only when numbers, and an
// icon's address only when short; a maker's long strings never fill the storage the wallet's key shares.
function trimmed(t: unknown): object {
    const v = t as { id?: unknown; name?: unknown; symbol?: unknown; icon?: unknown; isVerified?: unknown; usdPrice?: unknown; decimals?: unknown; stats24h?: { priceChange?: unknown }; totalSupply?: unknown; circSupply?: unknown; mcap?: unknown; holderCount?: unknown; liquidity?: unknown; audit?: { topHoldersPercentage?: unknown }; firstPool?: { createdAt?: unknown } };
    const n = (x: unknown) => (typeof x === 'number' ? x : null);
    const created = v.firstPool?.createdAt;
    return {
        id: v.id,
        name: clean(v.name),
        symbol: clean(v.symbol),
        icon: typeof v.icon === 'string' && v.icon.length <= 512 ? v.icon : null,
        isVerified: v.isVerified === true,
        usdPrice: n(v.usdPrice),
        decimals: n(v.decimals),
        stats24h: { priceChange: n(v.stats24h?.priceChange) },
        totalSupply: n(v.totalSupply),
        circSupply: n(v.circSupply),
        mcap: n(v.mcap),
        holderCount: n(v.holderCount),
        liquidity: n(v.liquidity),
        audit: { topHoldersPercentage: n(v.audit?.topHoldersPercentage) },
        firstPool: { createdAt: typeof created === 'string' ? created.slice(0, 64) : null },
    };
}

// Answers kept, the latest last, in place of any kept before for the same mints.
function keep(answers: Kept[]) {
    const mints = new Set(answers.map(([m]) => m));
    kept = [...kept!.filter(([m]) => !mints.has(m)), ...answers].slice(-MOST_KEPT);
    void platform.storage.session.set({ [KEPT]: kept }).catch(() => {}); // kept in memory still
}

/** Tokens whose name or symbol matches a few words, as Jupiter finds them (the swap's picker), through Otus's server or
 *  not; read with the same care. Each one found is kept as a lookup of its mint would keep it. */
export async function search(words: string, throughOtus: boolean): Promise<TokenInfo[]> {
    const query = words.trim();
    if (!query) return [];
    const response = await fetch(`${throughOtus ? THROUGH_OTUS : JUPITER}?query=${encodeURIComponent(query)}`, { method: methodFor(throughOtus), credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(WAIT) });
    if (!response.ok) throw new Error(`Jupiter answered ${response.status}`);
    const answer: unknown = await response.json();
    if (!Array.isArray(answer)) throw new Error('Jupiter answered something else');
    const found = answer.flatMap((t) => (info(t) ? [served(info(t)!, throughOtus)] : []));
    for (const t of found) looked.set(t.id, t);
    return found;
}

// A verified token's icon through Otus's server, which fetches it once, writes it anew and keeps it: quick, from any
// host, and no icon's host learns who looks. Otherwise as Jupiter gave it.
const served = (t: TokenInfo, throughOtus: boolean): TokenInfo => (throughOtus && t.icon && t.verified ? { ...t, icon: `${OTUS_RPC}/icon/${t.id}` } : t);

// Otus's server takes a search posted, the only way an extension's page sends its Origin to a host it may reach;
// Jupiter itself takes it as a GET.
const methodFor = (throughOtus: boolean) => (throughOtus ? 'POST' : 'GET');

/** What Jupiter said of a mint already, this page or worker: no request. */
export const cachedToken = (mint: string): TokenInfo | null => looked.get(mint) ?? null;

/** A mint's name and whether it is verified, from the latest answer kept for it, asked this way, however old: so a list
 *  the popup draws at once is named at once, and named again as a fresh answer comes. Names hardly change; nothing else
 *  of an old answer is read. */
export function keptName(mint: string, throughOtus: boolean): Pick<TokenInfo, 'symbol' | 'verified'> | null {
    const last = (kept ?? []).findLast(([m, , , through]) => m === mint && through === throughOtus);
    const t = last && last[1] !== null ? info(last[1]) : null;
    return t && { symbol: t.symbol, verified: t.verified };
}

// One of Jupiter's answers, read with care: its names come from token makers.
function info(t: unknown): TokenInfo | null {
    const v = t as { id?: unknown; name?: unknown; symbol?: unknown; icon?: unknown; isVerified?: unknown; usdPrice?: unknown; decimals?: unknown; stats24h?: { priceChange?: unknown }; totalSupply?: unknown; circSupply?: unknown; mcap?: unknown; holderCount?: unknown; liquidity?: unknown; audit?: { topHoldersPercentage?: unknown }; firstPool?: { createdAt?: unknown } };
    if (typeof v?.id !== 'string' || !isAddress(v.id)) return null; // a mint's address, or nothing
    return {
        id: v.id,
        name: clean(v.name),
        symbol: clean(v.symbol),
        icon: typeof v.icon === 'string' && v.icon.startsWith('https://') ? v.icon : null,
        verified: v.isVerified === true && !forged(v.id, clean(v.symbol)),
        usdPrice: finite(v.usdPrice),
        change24h: finite(v.stats24h?.priceChange),
        decimals: Number.isInteger(v.decimals) && (v.decimals as number) >= 0 && (v.decimals as number) <= 255 ? (v.decimals as number) : null, // a mint keeps them in one byte
        supply: supplyOf(finite(v.totalSupply), finite(v.circSupply)),
        market: marketOf(v),
    };
}

const SOLANA_BEGAN = Date.UTC(2020, 2, 16); // mainnet's first block: no pool opened before it

const MOST_USD = 1e15; // past any token's cap or liquidity: an answer saying more is wrong
const MOST_HOLDERS = 1e10;
const MOST_SUPPLY = 2 ** 64; // no token has more units than a u64 holds

// Each count only when it is one: a whole number of holders, a share between 0 and 100, a cap and liquidity not below
// 0, and a pool opened between Solana's start and now; none past what any token reaches.
function marketOf(v: { mcap?: unknown; holderCount?: unknown; liquidity?: unknown; audit?: { topHoldersPercentage?: unknown }; firstPool?: { createdAt?: unknown } }): Market | null {
    const holders = Number.isSafeInteger(v.holderCount) && (v.holderCount as number) >= 0 && (v.holderCount as number) <= MOST_HOLDERS ? (v.holderCount as number) + 0 : null;
    const share = finite(v.audit?.topHoldersPercentage);
    const [cap, liquidity] = [finite(v.mcap), finite(v.liquidity)];
    const opened = typeof v.firstPool?.createdAt === 'string' ? Date.parse(v.firstPool.createdAt) : NaN;
    const market: Market = {
        cap: cap !== null && cap >= 0 && cap <= MOST_USD ? cap : null,
        holders,
        topHolders: share !== null && share >= 0 && share <= 100 ? share : null,
        liquidity: liquidity !== null && liquidity >= 0 && liquidity <= MOST_USD ? liquidity : null,
        firstPool: opened >= SOLANA_BEGAN && opened <= Date.now() ? opened : null,
    };
    return Object.values(market).some((x) => x !== null) ? market : null;
}

// All of it and what circulates, both counted, and no more circulating than there is (but for float noise).
function supplyOf(total: number | null, circulating: number | null): Supply | null {
    return total !== null && circulating !== null && total <= MOST_SUPPLY && circulating >= 0 && circulating <= total * (1 + 1e-9) ? { total, circulating: Math.min(circulating, total) } : null;
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

const finite = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n + 0 : null); // -0 as 0

// No control or invisible characters, which could reorder or hide what is shown; and short.
const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 40) : '');

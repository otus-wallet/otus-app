// What a wallet holds: SOL and its token accounts from the RPC, names, icons and prices from Jupiter.
import { address, type Address } from '@solana/kit';

import { TOKEN_PROGRAMS, USDC, USDT, WSOL } from '@otus-wallet/sdk/programs/addresses';
import { rpcAt } from '@otus-wallet/sdk/rpc';
import { OTUS_RPC } from './settings.ts';
import { tokens, type TokenInfo } from './tokens.ts';

/** One asset of the wallet. `usd` is null when Jupiter has no price for it; `native`: SOL itself, not wrapped. */
export type Holding = {
    mint: string;
    symbol: string;
    name: string;
    icon: string | null;
    verified: boolean;
    native: boolean;
    units: bigint;
    decimals: number;
    usd: number | null;
    price: number | null;
    change: number | null; // percent over 24 hours
    source: { account: Address; program: Address; units: bigint } | null; // the token account to send from: the one holding most
};

/** What the wallet holds, most valuable first, SOL included. `usd`: the total of the priced, verified ones. */
export type Holdings = { usd: number; sol: bigint; assets: Holding[] };

export { USDC, USDT, WSOL };
const ALWAYS: string[] = [USDC, USDT]; // listed beside SOL even at 0, as most wallets hold them
const NAMES: Record<string, { symbol: string; name: string }> = { [WSOL]: { symbol: 'wSOL', name: 'Wrapped SOL' }, [USDC]: { symbol: 'USDC', name: 'USD Coin' }, [USDT]: { symbol: 'USDT', name: 'USDT' } }; // when Jupiter does not answer
/** `mainnet`: Jupiter's names and prices, and USDC and USDT listed at 0, are mainnet's: on another network the same
 *  addresses are other tokens, or none, and nothing has a price. */
export async function holdings(rpcUrl: string, owner: Address, mainnet = true): Promise<Holdings> {
    const rpc = rpcAt(rpcUrl);
    const [{ value: sol }, ...lists] = await Promise.all([
        rpc.getBalance(owner, { commitment: 'confirmed' }).send(),
        ...TOKEN_PROGRAMS.map((programId) => rpc.getTokenAccountsByOwner(owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }).send()),
    ]);
    // One line per mint, empty accounts left out; wrapped SOL is a token of its own.
    const units = new Map<string, { units: bigint; decimals: number; source: Holding['source']; most: bigint }>();
    lists.forEach(({ value }, i) => {
        for (const { pubkey, account } of value) {
            const info = parsed(account.data);
            if (!info || info.units === 0n) continue;
            const known = units.get(info.mint);
            const biggest = !known || info.units > known.most;
            units.set(info.mint, {
                units: (known?.units ?? 0n) + info.units,
                decimals: info.decimals,
                source: biggest ? { account: pubkey, program: TOKEN_PROGRAMS[i], units: info.units } : known.source,
                most: biggest ? info.units : known.most,
            });
        }
    });
    const always = mainnet ? ALWAYS : [];
    for (const mint of always) if (!units.has(mint)) units.set(mint, { units: 0n, decimals: 6, source: null, most: 0n });
    const known = mainnet ? await tokens([WSOL, ...units.keys()], rpcUrl === OTUS_RPC) : new Map<string, TokenInfo | null>();
    const value = (mint: string, u: bigint, decimals: number) => {
        const price = known.get(mint)?.usdPrice;
        return typeof price === 'number' ? (Number(u) / 10 ** decimals) * price : null;
    };
    const market = (mint: string) => ({ price: known.get(mint)?.usdPrice ?? null, change: known.get(mint)?.change24h ?? null });
    const native: Holding = { mint: WSOL, symbol: 'SOL', name: 'Solana', icon: null, verified: true, native: true, units: sol, decimals: 9, usd: value(WSOL, sol, 9), ...market(WSOL), source: null };
    const assets = [
        native,
        ...[...units].map(([mint, { units: u, decimals, source }]): Holding => {
            const t = known.get(mint);
            const verified = t?.verified === true || always.includes(mint);
            return {
                mint,
                symbol: NAMES[mint]?.symbol ?? t?.symbol ?? '',
                name: NAMES[mint]?.name ?? t?.name ?? '',
                icon: verified ? (t?.icon ?? null) : null, // an unverified token's image could be its maker's tracker
                verified,
                native: false,
                units: u,
                decimals,
                usd: value(mint, u, decimals),
                ...market(mint),
                source,
            };
        }),
    ];
    // Verified first, by value; then the rest, which a maker can price as they like with a pool of their own. SOL, USDC
    // and USDT lead among equals.
    const rank = (a: Holding) => (a.native ? 0 : ALWAYS.includes(a.mint) ? 1 + ALWAYS.indexOf(a.mint) : 3);
    assets.sort((a, b) => Number(b.verified) - Number(a.verified) || (b.usd ?? -1) - (a.usd ?? -1) || rank(a) - rank(b));
    return { usd: assets.reduce((sum, a) => sum + (a.verified ? (a.usd ?? 0) : 0), 0), sol, assets };
}

// A token account's mint and amount, as the RPC parses it; null when it reads otherwise.
function parsed(data: unknown): { mint: string; units: bigint; decimals: number } | null {
    const info = (data as { parsed?: { info?: { mint?: unknown; tokenAmount?: { amount?: unknown; decimals?: unknown } } } })?.parsed?.info;
    const amount = info?.tokenAmount?.amount;
    const decimals = info?.tokenAmount?.decimals;
    if (typeof info?.mint !== 'string' || typeof amount !== 'string' || !/^\d+$/.test(amount) || typeof decimals !== 'number') return null;
    return { mint: info.mint, units: BigInt(amount), decimals };
}

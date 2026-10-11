// Mainnet's lookup tables, kept while the browser runs: in session storage, which outlives the worker that sleeps when
// idle. A swap's route uses the same few tables again and again, and what a table holds stays true (the SDK's Tables).
import { isAddress, type Address } from '@solana/kit';

import type { Tables } from '@otus-wallet/sdk/chain';

const KEY = 'mainnetTables';
const MOST = 64; // tables kept: the latest read or used
const MOST_ENTRIES = 256; // what a lookup table holds at most

let kept: Promise<Map<Address, readonly Address[]>> | null = null;
const all = () =>
    (kept ??= chrome.storage.session.get(KEY).then(
        (stored) => new Map<Address, readonly Address[]>(listed(stored[KEY])),
        () => new Map<Address, readonly Address[]>(),
    ));

// What was stored, as stored: pairs of a table and its entries, every one an address; anything else is left out.
function listed(stored: unknown): [Address, Address[]][] {
    if (!Array.isArray(stored)) return [];
    return stored.filter((p): p is [Address, Address[]] => Array.isArray(p) && p.length === 2 && isAddress(p[0]) && Array.isArray(p[1]) && p[1].length <= MOST_ENTRIES && p[1].every((a) => typeof a === 'string' && isAddress(a)));
}

export const mainnetTables: Tables = {
    async get(table) {
        const tables = await all();
        const entries = tables.get(table);
        if (entries) tables.delete(table), tables.set(table, entries); // used: the latest
        return entries;
    },
    set(table, entries) {
        void all()
            .then((tables) => {
                tables.delete(table);
                tables.set(table, entries);
                for (const old of tables.keys()) if (tables.size > MOST) tables.delete(old);
                return chrome.storage.session.set({ [KEY]: [...tables] });
            })
            .catch(() => {}); // kept in memory still
    },
};

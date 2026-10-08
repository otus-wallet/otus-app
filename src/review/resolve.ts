import { address, getAddressDecoder, getArrayDecoder, getU32Decoder, type Address, type MaybeEncodedAccount } from '@solana/kit';

import type { Chain } from '../chain.ts';
import { Refused } from '../protocol.ts';
import type { Decoded, Message } from './decode.ts';

export const LOOKUP_TABLE_PROGRAM = address('AddressLookupTab1e1111111111111111111111111');

/** An account of the transaction, in the order instruction indices count them. */
export type Account = {
    address: Address;
    signer: boolean;
    writable: boolean; // as the message asks; the runtime may still demote programs and sysvars
    table: Address | null; // the lookup table it was loaded from; null when static
    state: MaybeEncodedAccount; // as the chain holds it now
};

export type Resolved = Decoded & { slot: bigint; accounts: Account[] };

/** Decoded → Resolved: loads the lookup tables, then every account's state. Throws Refused. */
export async function resolve(decoded: Decoded, chain: Chain): Promise<Resolved> {
    const { header: h, staticAccounts, lookups } = decoded.message;
    const tables = await loadTables(lookups.map((l) => l.lookupTableAddress), chain);
    const keys = [
        ...staticAccounts.map((address, i) => ({
            address,
            signer: i < h.numSignerAccounts,
            writable:
                i < h.numSignerAccounts
                    ? i < h.numSignerAccounts - h.numReadonlySignerAccounts
                    : i < staticAccounts.length - h.numReadonlyNonSignerAccounts,
            table: null,
        })),
        ...loaded(lookups, tables, 'writableIndexes'),
        ...loaded(lookups, tables, 'readonlyIndexes'),
    ];
    if (new Set(keys.map((k) => k.address)).size !== keys.length) throw new Refused('an account appears twice');
    const { slot, accounts } = await chain.accounts(keys.map((k) => k.address));
    return { ...decoded, slot, accounts: keys.map((k, i) => ({ ...k, state: accounts[i] })) };
}

// Loaded accounts follow the static ones: every table's writable entries, then every table's read-only ones.
function loaded(lookups: Message['lookups'], tables: Address[][], kind: 'writableIndexes' | 'readonlyIndexes') {
    return lookups.flatMap((l, t) =>
        l[kind].map((index) => {
            const address = tables[t][index];
            if (address === undefined) throw new Refused(`lookup table ${l.lookupTableAddress} has no entry ${index}`);
            return { address, signer: false, writable: kind === 'writableIndexes', table: l.lookupTableAddress };
        }),
    );
}

const TABLE_HEADER = 56; // type, deactivation slot, last extended slot and index, authority, padding

/** Lookup tables → the addresses each holds. Throws Refused for one that is not a live table. */
export async function loadTables(addresses: Address[], chain: Chain): Promise<Address[][]> {
    if (addresses.length === 0) return [];
    const { accounts } = await chain.accounts(addresses);
    return accounts.map((a) => {
        const ok =
            a.exists &&
            a.programAddress === LOOKUP_TABLE_PROGRAM &&
            a.data.length >= TABLE_HEADER &&
            (a.data.length - TABLE_HEADER) % 32 === 0 &&
            getU32Decoder().decode(a.data) === 1;
        if (!ok) throw new Refused(`lookup table ${a.address} not found`);
        return getArrayDecoder(getAddressDecoder(), { size: 'remainder' }).decode(a.data, TABLE_HEADER);
    });
}

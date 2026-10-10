// A token's terms as its details in the lobby say them: who can mint more, freeze, move or burn it, take a fee or
// pause it, and whether its name and logo can still change; then its supply and its token program.
import type { Address } from '@solana/kit';

import type { Metadata, MintTerms } from '@otus-wallet/sdk/access/mint';
import { amount } from '@otus-wallet/sdk/format';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@otus-wallet/sdk/programs/addresses';

/** One line: its name, what it says, and `warn` when that lets someone else take or stop yours. */
export type TokenFact = { name: string; value: string; warn?: boolean };

/** A mint's terms and its metadata in lines. `who`: an address's name, or the address in short; `symbol`: the token's. */
export function tokenFacts(terms: MintTerms, metadata: Metadata | null, symbol: string, who: (a: Address) => string): TokenFact[] {
    const facts: TokenFact[] = [
        { name: 'Mint authority', value: terms.mintAuthority ? who(terms.mintAuthority) : 'None' },
        { name: 'Freeze authority', value: terms.freezeAuthority ? who(terms.freezeAuthority) : 'None' },
    ];
    if (metadata) facts.push({ name: 'Metadata', value: metadata.mutable ? 'Mutable' : 'Immutable' });
    const others: string[] = [];
    for (const e of terms.extensions) {
        switch (e.kind) {
            case 'permanentDelegate':
                if (e.delegate) facts.push({ name: 'Permanent delegate', value: who(e.delegate), warn: true });
                break;
            case 'transferFee':
                facts.push({ name: 'Transfer fee', value: `${Math.max(e.older.bps, e.newer.bps) / 100}%` }); // the older holds until the newer's epoch, not read here: the higher of the two
                break;
            case 'transferHook':
                if (e.program) facts.push({ name: 'Transfer hook', value: who(e.program) });
                break;
            case 'pausable':
                if (e.paused) facts.push({ name: 'Transfers', value: 'Paused', warn: true });
                else if (e.authority) facts.push({ name: 'Pause authority', value: who(e.authority) });
                break;
            case 'defaultState':
                if (e.frozen) facts.push({ name: 'New accounts', value: 'Start frozen' });
                break;
            case 'nonTransferable':
                facts.push({ name: 'Transfers', value: 'Not allowed' });
                break;
            case 'closeAuthority':
                if (e.authority) facts.push({ name: 'Close authority', value: who(e.authority) });
                break;
            case 'permissionedBurn':
                if (e.authority) facts.push({ name: 'Burn authority', value: who(e.authority) });
                break;
            case 'other':
                others.push(e.name);
                break;
        }
    }
    if (others.length) facts.push({ name: 'Extensions', value: others.join(', ') });
    if (terms.unknown.length) facts.push({ name: 'Unreadable', value: terms.unknown.length === 1 ? 'An extension' : `${terms.unknown.length} extensions`, warn: true });
    facts.push({ name: 'Supply', value: `${amount(terms.supply, terms.decimals, false)} ${symbol}` });
    facts.push({ name: 'Program', value: terms.program === TOKEN_2022_PROGRAM_ADDRESS ? 'Token-2022' : 'Token' });
    return facts;
}

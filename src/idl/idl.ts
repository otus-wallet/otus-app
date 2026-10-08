// What a review shows of the instructions no plugin reads: each told with its program's IDL, where the program
// publishes one. Both places are read for every such program in one request; an instruction is told by the first IDL
// that knows it, the program's metadata first (a program may keep a partial one there, as Drift does: then Anchor's
// tells the rest). Shown as the program's own word; nothing here counts toward the verdict.
import type { Address } from '@solana/kit';

import type { Chain } from '../chain.ts';
import type { Review } from '../review/review.ts';
import { tellWith, type IdlInstruction } from './explain.ts';
import { idlAddresses, readIdl, type Idl } from './read.ts';

export type { IdlInstruction };

const MAX_PROGRAMS = 8; // programs whose IDLs one review reads

/** Review → its instructions no plugin reads, told by their programs' IDLs, by their place in the transaction. */
export async function toldByIdl(r: Review, chain: Chain): Promise<Map<number, IdlInstruction>> {
    const unread = r.explained.flatMap((e, i) => (e.source === 'unknown' ? [{ e, i }] : []));
    const programs = [...new Set(unread.map(({ e }) => e.program))].slice(0, MAX_PROGRAMS);
    const told = new Map<number, IdlInstruction>();
    if (!programs.length) return told;
    const places = await Promise.all(programs.map(idlAddresses));
    const { accounts } = await chain.accounts(places.flatMap((p) => [p.metadata, p.anchor]));
    const idls = new Map<Address, Idl[]>();
    await Promise.all(
        programs.map(async (program, k) => {
            const found = await Promise.all([readIdl(accounts[2 * k], 'metadata', program), readIdl(accounts[2 * k + 1], 'anchor', program)]);
            idls.set(program, found.filter((idl) => idl !== null));
        }),
    );
    for (const { e, i } of unread) {
        const t = tellWith(idls.get(e.program) ?? [], e.data, e.accounts.map((a) => a.address));
        if (t) told.set(i, t);
    }
    return told;
}

// Transactions your wallet signed that Otus did not: its phrase or key at work somewhere else, maybe someone else's.
// Read from the activity Otus reads anyway, against the signatures Otus made: no request of its own.

/** What has been checked of a wallet's activity: the newest slot looked at; the stretches below it not looked at yet
 *  (more landed between two looks than a page holds), as slots between, both left out; the transactions found signed
 *  outside Otus, the latest last; and whether one is still to be seen in Activity. Slots as digits: storage takes JSON. */
export type Outside = { seen: string; gaps: [string, string][]; flagged: string[]; unseen: boolean };

/** A transaction as Activity read it: its id, slot, time, and each signer's signature. */
export type Looked = { signature: string; slot: bigint; time: number | null; signatures: Readonly<Record<string, string>> };

const MAX_FLAGGED = 50;
const MAX_GAPS = 4;

/**
 * A wallet's transactions as read (newest first, the first pages; `more` when others follow) → what is checked now, and
 * the ones newly found signed outside Otus: the wallet's signature is on them, and not among `here`, the ones Otus
 * made. Never checked before, what landed before the wallet came into Otus (`since`, seconds) counts as seen; with no
 * `since` (it came before Otus checked), all that shows now does.
 */
export function lookOutside(read: Looked[], wallet: string, before: Outside | undefined, here: ReadonlySet<string>, since: number | undefined, more: boolean): { now: Outside; found: string[] } {
    const slots = read.map((t) => t.slot);
    const newest = slots.reduce((a, b) => (b > a ? b : a), -1n);
    const oldest = slots.reduce((a, b) => (b < a ? b : a), newest);
    let fresh: Looked[];
    let seen: bigint;
    let gaps: [bigint, bigint][] = [];
    if (!before) {
        fresh = since === undefined ? [] : read.filter((t) => t.time !== null && t.time >= since);
        seen = newest < 0n ? 0n : newest;
    } else {
        const was = BigInt(before.seen);
        const old = before.gaps.map(([a, b]) => [BigInt(a), BigInt(b)] as [bigint, bigint]);
        fresh = read.filter((t) => t.slot > was || old.some(([a, b]) => t.slot > a && t.slot < b));
        // What is read covers every slot between its oldest and its newest, and all below too once nothing more follows:
        // of each stretch, what is left above and below that; and below the newest read, if more landed than it holds.
        if (read.length === 0) gaps = old;
        else {
            gaps = old.flatMap(([a, b]): [bigint, bigint][] => [...(more && oldest - a > 1n ? [[a, b < oldest ? b : oldest] as [bigint, bigint]] : []), ...(b - newest > 1n ? [[newest > a ? newest : a, b] as [bigint, bigint]] : [])]);
            if (more && newest > was && oldest - was > 1n) gaps.push([was, oldest]);
        }
        seen = newest > was ? newest : was;
    }
    const flagged = before?.flagged ?? [];
    const found = fresh.filter((t) => t.signatures[wallet] !== undefined && !here.has(t.signatures[wallet]) && !flagged.includes(t.signature)).map((t) => t.signature);
    const now: Outside = {
        seen: seen.toString(),
        gaps: gaps
            .toSorted(([a], [b]) => (b > a ? 1 : -1))
            .slice(0, MAX_GAPS)
            .map(([a, b]) => [a.toString(), b.toString()]),
        flagged: [...flagged, ...found].slice(-MAX_FLAGGED),
        unseen: (before?.unseen ?? false) || found.length > 0,
    };
    return { now, found };
}

/** Where a wallet's checks are kept: by network, as each counts its own slots. */
export const outsideKey = (cluster: string, wallet: string) => `${cluster} ${wallet}`;

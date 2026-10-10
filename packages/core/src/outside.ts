// Transactions your wallet signed that Otus did not: its phrase or key at work somewhere else, maybe someone else's.
// Read from the activity Otus reads anyway, against the signatures Otus made: no request of its own.

/** What has been checked of a wallet's activity: the newest slot looked at; the stretches below it not looked at yet
 *  (more landed between two looks than was read), as slots between, both left out; the transactions found signed
 *  outside Otus, the latest last; whether one is still to be seen in Activity; and the time (seconds) before which
 *  nothing counts, when none was read yet. Slots as digits: storage takes JSON. */
export type Outside = { seen: string; gaps: [string, string][]; flagged: string[]; unseen: boolean; from?: number };

/** A transaction as Activity read it: its id, slot, time, and each signer's signature. */
export type Looked = { signature: string; slot: bigint; time: number | null; signatures: Readonly<Record<string, string>> };

/** A look: what was read (newest first, the first pages), whether more follows, what was checked before, the
 *  signatures Otus made (`here`), when the wallet came into Otus (`since`, seconds; none for one it had before keeping
 *  this), and the time now (seconds). */
export type Look = { read: Looked[]; wallet: string; before?: Outside; here: ReadonlySet<string>; since?: number; more: boolean; now: number };

const MAX_FLAGGED = 50;
const MAX_GAPS = 4;
const MAX_SLOT = 2n ** 40n; // past any slot Solana reaches in thousands of years: an RPC's that says so is not believed
const EARLIER = 3600; // s: with nothing read and no time it came, what landed this long before the first look counts

/**
 * A look → what is checked now, and the transactions newly found signed outside Otus: the wallet's signature is on
 * them, and not among the ones Otus made. Never checked before, what shows now counts as seen, except what landed since
 * the wallet came into Otus.
 */
export function lookOutside({ read: all, wallet, before, here, since, more, now: at }: Look): { now: Outside; found: string[] } {
    const read = all.filter((t) => t.slot < MAX_SLOT);
    const newest = read.reduce((a, t) => (t.slot > a ? t.slot : a), -1n);
    const oldest = read.reduce((a, t) => (t.slot < a ? t.slot : a), newest);
    const from = before ? before.from : since;
    const counts = (t: Looked) => from === undefined || (t.time !== null && t.time >= from);
    // Nothing to go by: from when it came, or a little before now, all counts.
    if (!before && read.length === 0) return { now: { seen: '0', gaps: [], flagged: [], unseen: false, from: since ?? at - EARLIER }, found: [] };
    // Checked up to here: what was seen; never checked, all that shows when the wallet came before Otus kept when, and
    // from the start (by time, from when it came) when it came since.
    const was = before ? BigInt(before.seen) : since === undefined ? newest : -1n;
    const old = (before?.gaps ?? []).map(([a, b]) => [BigInt(a), BigInt(b)] as [bigint, bigint]);
    const fresh = read.filter((t) => (t.slot > was || old.some(([a, b]) => t.slot > a && t.slot < b)) && counts(t));
    // What is read covers every slot above its oldest up to its newest, and that oldest slot only in part while more
    // follows (a page can end inside a slot); all below as well once nothing does, or once it reaches what landed before
    // anything counts. Of each stretch, what is left above and below that; and a stretch down from the newest read, when
    // more landed than it holds.
    let gaps = old;
    if (read.length > 0) {
        const done = !more || (from !== undefined && read.some((t) => t.time !== null && t.time < from));
        const floor = done ? -1n : oldest + 1n; // what is read reaches down to here, this slot left out
        gaps = old.flatMap(([a, b]): [bigint, bigint][] => [...(floor - a > 1n ? [[a, b < floor ? b : floor] as [bigint, bigint]] : []), ...(b - newest > 1n ? [[newest > a ? newest : a, b] as [bigint, bigint]] : [])]);
        if (!done && newest > was && floor - was > 1n) gaps.push([was, floor]);
    }
    const seen = newest > was ? newest : was;
    gaps.sort(([a], [b]) => (b > a ? 1 : -1));
    // Past the most kept, the lowest two become one: checked again, rather than left unchecked.
    while (gaps.length > MAX_GAPS) {
        const [low, next] = [gaps.pop()!, gaps.pop()!];
        gaps.push([low[0], next[1]]);
    }
    const flagged = before?.flagged ?? [];
    const found = fresh.filter((t) => t.signatures[wallet] !== undefined && !here.has(t.signatures[wallet]) && !flagged.includes(t.signature)).map((t) => t.signature);
    const now: Outside = {
        seen: seen.toString(),
        gaps: gaps.map(([a, b]) => [a.toString(), b.toString()]),
        flagged: [...flagged, ...found].slice(-MAX_FLAGGED),
        unseen: (before?.unseen ?? false) || found.length > 0,
        ...(from !== undefined && { from }),
    };
    return { now, found };
}

/** Whether part of a wallet's activity is still to be checked: more landed than was read. */
export const unchecked = (o: Outside | undefined) => (o?.gaps.length ?? 0) > 0;

/** Where a wallet's checks are kept: by network, as each counts its own slots. */
export const outsideKey = (cluster: string, wallet: string) => `${cluster} ${wallet}`;

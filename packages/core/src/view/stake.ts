// Native stake in words, for the Stake screen: where each stake stands and when that changes, each validator as it
// declares itself and what the network shows of it, and what keeps a new stake from going on.
import { short, sol } from '@otus-wallet/sdk/format';

import type { Standing } from '../stake/stakes.ts';
import type { Validator } from '../stake/validators.ts';
import { decimal } from '../money.ts';

const SHOWN = 50; // validators listed before a search narrows them

/** About how long, in words: "~25 min", "~13 h", "~2 d 4 h". */
export function about(seconds: number): string {
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) return `~${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `~${hours} h`;
    return `~${Math.floor(hours / 24)} d${hours % 24 ? ` ${hours % 24} h` : ''}`;
}

/** Where a stake stands, in words, with when it next changes: the epoch's end, `left` seconds away when known. */
export function standingWords(standing: Standing, left: number | null, locked: boolean): string {
    const end = left === null ? 'next epoch' : `in ${about(left)}`;
    switch (standing) {
        case 'idle':
            return locked ? 'Not staked, locked by its custodian' : 'Not staked';
        case 'activating':
            return `Starts earning ${end}`;
        case 'active':
            return 'Earning';
        case 'deactivating':
            return `Unstaking: ready ${end}`;
        case 'inactive':
            return locked ? 'Unstaked, locked by its custodian' : 'Ready to withdraw';
    }
}

/** SOL in short, for a validator's stake: "15.9M", "230K", "950". */
export function compact(lamports: bigint): string {
    const n = Number(lamports) / 1e9;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
    return `${Math.round(n)}`;
}

/** A validator in words: its name or address; its address, commission and stake; what to know before staking with it
 *  (`danger`: it would earn nothing). */
export function validatorWords(v: Validator): { title: string; sub: string; notes: { text: string; tone: 'warn' | 'danger' }[] } {
    const notes: { text: string; tone: 'warn' | 'danger' }[] = [];
    if (!v.voting) notes.push({ text: 'Not voting now: it earns no rewards', tone: 'danger' });
    if (v.commission === 100) notes.push({ text: 'It keeps all the rewards', tone: 'warn' });
    if (v.twin) notes.push({ text: 'Another validator uses a name like this', tone: 'warn' });
    return { title: v.name ?? short(v.vote), sub: `${short(v.vote)} · ${v.commission}% commission · ${compact(v.stake)} SOL staked`, notes };
}

/** The validators a search finds: by name, or by vote or identity address, whole or its start. Without one, the best
 *  paying that vote. */
export function search(validators: readonly Validator[], query: string): Validator[] {
    const q = query.trim();
    if (!q) return validators.filter((v) => v.voting).slice(0, SHOWN);
    const folded = q.normalize('NFKC').toLowerCase();
    const address = /^[1-9A-HJ-NP-Za-km-z]{4,44}$/.test(q);
    return validators.filter((v) => (v.name !== null && v.name.normalize('NFKC').toLowerCase().includes(folded)) || (address && (v.vote.startsWith(q) || v.node.startsWith(q))));
}

/** What keeps a new stake from going on, in words, checked in the order it is read; empty when nothing does. `most`:
 *  what can be staked, rent and fees left aside. */
export function stakeProblem(f: { text: string; units: bigint | null; min: bigint | null; most: bigint | null }): string {
    if (f.text.includes(',')) return 'Use a point for decimals: 0.05, not 0,05';
    if (f.text && f.units === null) return 'An amount above 0, with at most 9 decimals';
    if (f.units === null) return '';
    if (f.min !== null && f.units < f.min) return `At least ${sol(f.min)} SOL: the network's minimum`;
    if (f.most !== null && f.units > f.most) return f.most > 0n ? `At most ${decimal(f.most, 9)} SOL: some stays for rent and fees` : 'Not enough SOL: some stays for rent and fees';
    return '';
}

// The validators one can stake with, as the network has them: each vote account, its commission and stake, whether it
// votes, how well it voted of late, and whether it is among the few that together hold a third of all stake. Their
// names are what each declared of itself onchain (validator info, signed by its identity), never checked by anyone:
// a name another validator uses as well is marked, and the address always shows beside it.
import { getBase58Decoder, getBase64Encoder, type Address, type Rpc, type SolanaRpcApi } from '@solana/kit';

import { named } from '../shell/state.ts';

const CONFIG_PROGRAM = 'Config1111111111111111111111111111111111111' as Address;
const VALIDATOR_INFO = 'Va1idator1nfo111111111111111111111111111111';
const EPOCHS = 3; // the last complete epochs a validator's votes are counted over

/** A validator to stake with. `score`: what it would have paid of late, its vote credits over the last few complete
 *  epochs times what its commission leaves; `top`: one of the largest, which together hold a third of all stake;
 *  `twin`: another validator declares the same name, or one drawn alike. */
export type Validator = { vote: Address; node: Address; commission: number; stake: bigint; score: bigint; voting: boolean; top: boolean; name: string | null; twin: boolean };

type VoteAccount = { votePubkey: Address; nodePubkey: Address; commission: number; activatedStake: bigint; epochCredits: readonly (readonly [bigint, bigint, bigint])[] };

/** The validators, voting ones first, the best paying first; `names` gives the declared names of these identities. */
export async function validatorsOf(rpc: Rpc<SolanaRpcApi>, epoch: bigint, names: (nodes: Set<string>) => Promise<ReadonlyMap<string, string>>): Promise<Validator[]> {
    const { current, delinquent } = await rpc.getVoteAccounts({ commitment: 'confirmed' }).send();
    const all = [...current, ...delinquent] as readonly VoteAccount[];
    return ranked(current as readonly VoteAccount[], delinquent as readonly VoteAccount[], epoch, await names(new Set(all.map((v) => v.nodePubkey))));
}

/** Vote accounts → validators, ranked: voting first, then by score, then by address for a steady order. */
export function ranked(current: readonly VoteAccount[], delinquent: readonly VoteAccount[], epoch: bigint, names: ReadonlyMap<string, string>): Validator[] {
    const all = [...current.map((v) => [v, true] as const), ...delinquent.map((v) => [v, false] as const)];
    const total = all.reduce((n, [v]) => n + v.activatedStake, 0n);
    // The largest, as few as together hold a third of all stake: were they to stop, the network would.
    const top = new Set<string>();
    let held = 0n;
    for (const [v] of all.toSorted(([a], [b]) => (b.activatedStake > a.activatedStake ? 1 : b.activatedStake < a.activatedStake ? -1 : 0))) {
        if (held * 3n >= total) break;
        top.add(v.votePubkey);
        held += v.activatedStake;
    }
    const counted = new Map<string, Set<string>>(); // a name's skeleton → the vote accounts declaring one like it
    for (const [v] of all) {
        const name = names.get(v.nodePubkey);
        const k = name && skeleton(name);
        if (k) counted.set(k, (counted.get(k) ?? new Set()).add(v.votePubkey));
    }
    const validators = all.map(([v, voting]): Validator => {
        const name = names.get(v.nodePubkey) ?? null;
        const commission = Math.min(Math.max(v.commission, 0), 100);
        return {
            vote: v.votePubkey,
            node: v.nodePubkey,
            commission,
            stake: v.activatedStake,
            score: earned(v.epochCredits, epoch) * BigInt(100 - commission),
            voting,
            top: top.has(v.votePubkey),
            name,
            twin: name !== null && (counted.get(skeleton(name))?.size ?? 0) > 1,
        };
    });
    return validators.toSorted((a, b) => Number(b.voting) - Number(a.voting) || (b.score > a.score ? 1 : b.score < a.score ? -1 : 0) || (a.vote < b.vote ? -1 : 1));
}

// The vote credits earned in the last few complete epochs, none for one it missed: each entry is an epoch, its credits,
// and those before it.
function earned(credits: VoteAccount['epochCredits'], epoch: bigint): bigint {
    return credits.filter(([e]) => e < epoch && e >= epoch - BigInt(EPOCHS)).reduce((n, [, now, before]) => n + (now > before ? now - before : 0n), 0n);
}

// Letters of other scripts drawn like Latin ones (as Unicode's confusables have them), and Latin ones drawn alike.
const LOOKALIKE: Record<string, string> = Object.fromEntries(
    [
        ['аАαΑ', 'a'], ['вВβΒ', 'b'], ['сСϲ', 'c'], ['ԁ', 'd'], ['еЕεΕ', 'e'], ['ɡ', 'g'], ['һНΗ', 'h'], ['іІιΙıɩ1|!', 'l'],
        ['јЈȷ', 'j'], ['кКκΚ', 'k'], ['мМΜ', 'm'], ['ΝпП', 'n'], ['оОοΟσ0', 'o'], ['рРρΡ', 'p'], ['ԛԚ', 'q'], ['ѕЅ', 's'],
        ['тТτΤ', 't'], ['υ', 'u'], ['νѵ', 'v'], ['ԝԜ', 'w'], ['хХχΧ', 'x'], ['уУүҮΥγ', 'y'], ['Ζ', 'z'],
    ].flatMap(([from, to]) => [...from].map((c) => [c, to])),
);

// A name as compared, so that names drawn alike match: accents and marks off, look-alike letters as Latin, case aside,
// "i" as "l", "rn" as "m", "vv" as "w", a number at its end and everything but letters and digits dropped. Empty when
// too little is left to tell names apart.
export function skeleton(name: string): string {
    const bare = name.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[\s\d\p{P}\p{S}]+$/u, '');
    const latin = [...bare].map((c) => LOOKALIKE[c] ?? c).join('').toLowerCase();
    const k = latin.replace(/i/g, 'l').replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[^a-z0-9]/g, '');
    return k.length >= 3 ? k : '';
}

/** Each validator identity's declared name, from the Config program's validator info accounts. */
export async function validatorNames(rpc: Rpc<SolanaRpcApi>): Promise<Map<string, string>> {
    const found = await rpc
        .getProgramAccounts(CONFIG_PROGRAM, { encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 1n, bytes: VALIDATOR_INFO as never, encoding: 'base58' } }] })
        .send();
    return namesOf(found.map(({ account }) => new Uint8Array(getBase64Encoder().encode(account.data[0]))));
}

/** Validator info accounts' bytes → each identity's name. An identity that declares different names in different
 *  accounts gets none: which is current cannot be told. */
export function namesOf(accounts: Uint8Array[]): Map<string, string> {
    const names = new Map<string, string | null>();
    for (const data of accounts) {
        const info = infoOf(data);
        if (!info) continue;
        const before = names.get(info.node);
        names.set(info.node, before === undefined || before === info.name ? info.name : null);
    }
    return new Map([...names].filter((e): e is [string, string] => e[1] !== null));
}

// One validator info account: two keys (the Validator Info key, not signing; the validator's identity, which signed
// it), then its JSON as a length (u64) and UTF-8 text. Anything else is not read.
const KEYS = 1 + 2 * 33;
function infoOf(data: Uint8Array): { node: string; name: string } | null {
    const b58 = getBase58Decoder();
    if (data.length < KEYS + 8 || data[0] !== 2 || data[33] !== 0 || data[66] !== 1 || b58.decode(data.subarray(1, 33)) !== VALIDATOR_INFO) return null;
    const length = new DataView(data.buffer, data.byteOffset + KEYS, 8).getBigUint64(0, true);
    if (length > BigInt(data.length - KEYS - 8)) return null;
    let info: unknown;
    try {
        info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(KEYS + 8, KEYS + 8 + Number(length))));
    } catch {
        return null;
    }
    // Marks stacked on a letter, past two, are dropped: piled up, they spill over the text around.
    const name = info !== null && typeof info === 'object' && typeof (info as { name?: unknown }).name === 'string' ? named((info as { name: string }).name.normalize('NFKC').replace(/(\p{M}{2})\p{M}+/gu, '$1')) : '';
    return name ? { node: b58.decode(data.subarray(34, 66)), name } : null;
}

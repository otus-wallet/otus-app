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
 *  `twin`: another validator declares the same name. */
export type Validator = { vote: Address; node: Address; commission: number; stake: bigint; score: bigint; voting: boolean; top: boolean; name: string | null; twin: boolean };

type VoteAccount = { votePubkey: Address; nodePubkey: Address; commission: number; activatedStake: bigint; epochCredits: readonly (readonly [bigint, bigint, bigint])[] };

/** The validators, voting ones first, the best paying first; `names`: each identity's declared name. */
export async function validatorsOf(rpc: Rpc<SolanaRpcApi>, epoch: bigint, names: ReadonlyMap<string, string>): Promise<Validator[]> {
    const { current, delinquent } = await rpc.getVoteAccounts({ commitment: 'confirmed' }).send();
    return ranked(current as readonly VoteAccount[], delinquent as readonly VoteAccount[], epoch, names);
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
    const counted = new Map<string, Set<string>>(); // a name, folded → the vote accounts declaring it
    for (const [v] of all) {
        const name = names.get(v.nodePubkey);
        if (name) counted.set(fold(name), (counted.get(fold(name)) ?? new Set()).add(v.votePubkey));
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
            twin: name !== null && (counted.get(fold(name))?.size ?? 0) > 1,
        };
    });
    return validators.toSorted((a, b) => Number(b.voting) - Number(a.voting) || (b.score > a.score ? 1 : b.score < a.score ? -1 : 0) || (a.vote < b.vote ? -1 : 1));
}

// The vote credits earned in the last few complete epochs: each entry is an epoch, its credits, and those before it.
function earned(credits: VoteAccount['epochCredits'], epoch: bigint): bigint {
    return credits
        .filter(([e]) => e < epoch)
        .slice(-EPOCHS)
        .reduce((n, [, now, before]) => n + (now > before ? now - before : 0n), 0n);
}

// A name as compared: its compatibility forms folded, case aside.
const fold = (name: string) => name.normalize('NFKC').toLowerCase();

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
    const name = info !== null && typeof info === 'object' && typeof (info as { name?: unknown }).name === 'string' ? named((info as { name: string }).name) : '';
    return name ? { node: b58.decode(data.subarray(34, 66)), name } : null;
}

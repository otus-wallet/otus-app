// What the window says beside the review's findings: imitated tokens, and each finding's second line, a failed
// simulation's reason included.
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import type { Address } from '@solana/kit';

import { cap, quantity, sol, SOL_DECIMALS, told } from '@otus-wallet/sdk/format';
import type { Finding, Flow } from '@otus-wallet/sdk/review/assess';
import type { Names } from '@otus-wallet/sdk/review/effects';
import type { Review } from '@otus-wallet/sdk/review/review';
import type { Prepared } from '@otus-wallet/sdk/prepare/prepare';
import { latin } from '@otus-wallet/sdk/review/sites';
import type { TokenInfo } from '../tokens.ts';
import { IMITATED } from '@otus-wallet/sdk/activity/symbols';


// A token that is not verified, named as one people know: warned of, wherever it is in the transaction.
export function imitations(tokens: Map<string, TokenInfo | null>, mainnet: boolean): Finding[] {
    if (!mainnet) return [];
    const known = new Set([...tokens.values()].flatMap((t) => (t?.verified ? [latin(t.symbol).toUpperCase()] : [])));
    return [...tokens].flatMap(([mint, t]): Finding[] => {
        const symbol = t ? latin(t.symbol).toUpperCase() : '';
        if (!t || t.verified || !symbol || !(IMITATED.has(symbol) || known.has(symbol))) return [];
        return [{ level: 'warn', code: 'imitation', text: `A token calls itself ${t.symbol}, and it is not the real one`, subject: mint as Address, note: `${mint} is not verified: anyone can name a token ${t.symbol}` }];
    });
}

/** Tokens whose mint, as the RPC read it, has other decimals than the token list gives it: one of them is wrong, and
 *  amounts shown by the mint's may be off a thousandfold or more. A mint's decimals never change. */
export function misread(known: { tokens: Map<string, TokenInfo | null>; decimals: Map<string, number> }): Finding[] {
    return [...known.decimals].flatMap(([mint, places]): Finding[] => {
        const listed = known.tokens.get(mint)?.decimals;
        if (typeof listed !== 'number' || listed === places) return [];
        return [{ level: 'danger', code: 'decimals-differ', text: "A token's amounts may be wrong", subject: mint as Address, note: `The RPC gives it ${places} decimals, the token list ${listed}` }];
    });
}

// A finding's second line: what it is about, in words. A few say it from the review itself.
export function noteOf(f: Finding, r: Review, p: Prepared | null, n: Names): string {
    const flowText = (flow: Flow) => {
        const t = flow.asset === 'SOL' ? { symbol: 'SOL', decimals: SOL_DECIMALS } : n.token(flow.asset);
        return `${quantity(flow.change, t.decimals)} ${t.symbol}`;
    };
    if (f.code === 'simulated') return r.assessment.flows.map(flowText).join(' · ') || 'No balance of yours changes';
    if (f.code === 'normal-fee' || f.code === 'high-fee') return p ? `${sol(p.fee)} SOL for this transaction` : '';
    if (f.code === 'simulation-failed') return failure(r, n) ?? f.note ?? '';
    if (f.code === 'sends-to-wallet') {
        const out = r.assessment.flows.filter((flow) => flow.change < 0n);
        return `${out.map(flowText).join(' and ')} → ${f.subject ?? 'someone else'}`;
    }
    if (f.code === 'pays-others' || f.code === 'pays-known') {
        const p = r.assessment.payouts.find((x) => x.holder === f.subject);
        if (!p) return '';
        const amounts = p.amounts.map(({ asset, amount }) => {
            const t = asset === 'SOL' ? { symbol: 'SOL', decimals: SOL_DECIMALS } : n.token(asset);
            return `${quantity(amount, t.decimals)} ${t.symbol}`;
        });
        const through = p.programs.length ? ` · through ${p.programs.map((q) => n.program(q)).join(', ')}` : '';
        return `${amounts.join(' and ')}${p.known ? '' : ` → ${p.holder}`}${through}`;
    }
    if (f.code === 'large-outflow' && f.subject) return n.token(f.subject).symbol; // the token, by its symbol when verified
    if (f.code === 'guards-leeway' && p) {
        const what = [p.leeway.lamports > 0n && `up to ${sol(p.leeway.lamports)} SOL`, p.leeway.units > 0n && 'some of your tokens'].filter(Boolean).join(' and ');
        return `${cap(what)} more than shown, as others here move them between your accounts: the site may never send those`;
    }
    if (f.code === 'check-balances') {
        const [out, back] = [r.assessment.flows.filter((flow) => flow.change < 0n), r.assessment.flows.filter((flow) => flow.change > 0n)];
        return `${out.map(flowText).join(' and ')} out · ${back.map(flowText).join(' and ')} in`;
    }
    return f.note || f.subject || '';
}

// Why the simulation failed, in words: the program's own message when its logs give one (as "Slippage tolerance
// exceeded"), quoted as its words, else the error by name, with the instruction and program it came from.
function failure(r: Review, n: Names): string | null {
    const e = r.simulation.error;
    if (e === null) return null;
    const logged = r.simulation.logs.map((l) => /Error Message: (.+?)\.?$/.exec(l)?.[1] ?? /^Program log: Error: (.+?)\.?$/.exec(l)?.[1]).findLast((m) => m !== undefined);
    const quoted = logged === undefined ? '' : told(logged.replace(/[“”"«»„‟❝❞〝〞＂]/g, ''));
    if (quoted) return `“${cap(quoted)}”`;
    if (e === 'InsufficientFundsForFee') return 'Not enough SOL for the fee';
    if (typeof e === 'object' && 'InsufficientFundsForRent' in e) return 'An account would be left without its rent';
    if (typeof e === 'object' && 'InstructionError' in e) {
        const [at, why] = e.InstructionError;
        const index = Number(at); // the RPC's answer gives it as a bigint
        const ix = r.message.instructions[index];
        const address = ix ? r.accounts[ix.programAddressIndex].address : null;
        // The System Program says why a transfer fails in its own log: what there is, what it needs. Only read when it
        // is the one that fails, so no other program can write it.
        const lacking = address === SYSTEM_PROGRAM_ADDRESS ? /^Transfer: insufficient lamports (\d+), need (\d+)$/m.exec(r.simulation.logs.join('\n')) : null;
        if (lacking) return `Not enough SOL: needs ${sol(BigInt(lacking[2]))}, has ${sol(BigInt(lacking[1]))}`;
        const program = address ? n.program(address) : 'its program';
        return `Instruction ${index + 1} (${program}) fails: ${typeof why === 'string' ? words(why) : 'Custom' in why ? `error ${why.Custom}` : 'an error'}`;
    }
    return typeof e === 'string' ? cap(words(e)) : 'It fails';
}

// An error's name as words: "InsufficientFunds" → "insufficient funds".
const words = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();


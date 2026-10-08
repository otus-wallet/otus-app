// What the window says beside the review's findings: imitated tokens, and each finding's second line, a failed
// simulation's reason included.
import type { Address } from '@solana/kit';

import { cap, quantity, short, sol, SOL_DECIMALS, told } from '@otus-wallet/sdk/format';
import type { Finding, Flow } from '@otus-wallet/sdk/review/assess';
import type { Names } from '@otus-wallet/sdk/review/effects';
import type { Review } from '@otus-wallet/sdk/review/review';
import type { Prepared } from '@otus-wallet/sdk/prepare/prepare';
import { latin } from '@otus-wallet/sdk/review/sites';
import type { TokenInfo } from '../../tokens.ts';

// Symbols scams like to give their own tokens: one of these on a token that is not verified gets a warning.
const IMITATED = new Set(['SOL', 'WSOL', 'USDC', 'USDT', 'JUP', 'BONK', 'JTO', 'PYTH', 'RAY', 'ORCA', 'MSOL', 'JITOSOL', 'BSOL', 'JUPSOL', 'INF', 'WIF', 'TRUMP', 'ETH', 'WETH', 'BTC', 'WBTC', 'CBBTC', 'PYUSD', 'USDS', 'USDE', 'EURC', 'PENGU', 'POPCAT', 'RENDER', 'HNT']);

// A token that is not verified, named as one people know: warned of, wherever it is in the transaction.
export function imitations(tokens: Map<string, TokenInfo | null>, mainnet: boolean): Finding[] {
    if (!mainnet) return [];
    const known = new Set([...tokens.values()].flatMap((t) => (t?.verified ? [latin(t.symbol).toUpperCase()] : [])));
    return [...tokens].flatMap(([mint, t]): Finding[] => {
        const symbol = t ? latin(t.symbol).toUpperCase() : '';
        if (!t || t.verified || !symbol || !(IMITATED.has(symbol) || known.has(symbol))) return [];
        return [{ level: 'warn', code: 'imitation', text: `A token calls itself ${t.symbol}, and it is not the real one`, subject: mint as Address, note: `${short(mint)} is not verified: anyone can name a token ${t.symbol}` }];
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
        return `${out.map(flowText).join(' and ')} → ${f.subject ? short(f.subject) : 'someone else'}`;
    }
    if (f.code === 'pays-others' || f.code === 'pays-known') {
        const p = r.assessment.payouts.find((x) => x.holder === f.subject);
        if (!p) return '';
        const amounts = p.amounts.map(({ asset, amount }) => {
            const t = asset === 'SOL' ? { symbol: 'SOL', decimals: SOL_DECIMALS } : n.token(asset);
            return `${quantity(amount, t.decimals)} ${t.symbol}`;
        });
        const through = p.programs.length ? ` · through ${p.programs.map((q) => n.program(q)).join(', ')}` : '';
        return `${amounts.join(' and ')}${p.known ? '' : ` → ${short(p.holder)}`}${through}`;
    }
    if (f.code === 'large-outflow' && f.subject) return n.token(f.subject).symbol; // the token, by its symbol when verified
    if (f.code === 'check-balances') {
        const [out, back] = [r.assessment.flows.filter((flow) => flow.change < 0n), r.assessment.flows.filter((flow) => flow.change > 0n)];
        return `${out.map(flowText).join(' and ')} out · ${back.map(flowText).join(' and ')} in`;
    }
    if (f.note) return f.note.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, (a) => short(a));
    return f.subject ? short(f.subject) : '';
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
        const [index, why] = e.InstructionError;
        const ix = r.message.instructions[index];
        const program = ix ? n.program(r.accounts[ix.programAddressIndex].address) : 'its program';
        return `Instruction ${index + 1} (${program}) fails: ${typeof why === 'string' ? words(why) : 'Custom' in why ? `error ${why.Custom}` : 'an error'}`;
    }
    return typeof e === 'string' ? cap(words(e)) : 'It fails';
}

// An error's name as words: "InsufficientFunds" → "insufficient funds".
const words = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();


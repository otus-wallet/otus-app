// What one instruction does, in words: a short line for its arguments, and its effects. Read from what its plugin
// says, for the programs Otus reads; for any other, what the simulation changed in your accounts it touches.
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from '@solana-program/compute-budget';
import { LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3, MEMO_PROGRAM_ADDRESS } from '@solana-program/memo';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import type { Address, ReadonlyUint8Array } from '@solana/kit';

import { amount, cap, sol } from '../format.ts';
import { TOKEN_PROGRAMS } from '../programs/addresses.ts';
import type { Tone } from './assess.ts';
import type { Explained } from './explain.ts';

export type Effect = { text: string; tone: Tone };
export type Story = { args: string; effects: Effect[] };

/** What the words need to know about the accounts and tokens of the transaction. */
export type Names = {
    wallet: Address;
    who(address: Address): string; // "you", "your USDC account", "4Vn8…Qe2T", a program's name
    mine(address: Address): boolean;
    existed(address: Address): boolean; // before the transaction
    mintOf(tokenAccount: Address): Address | null;
    token(mint: Address | null): { symbol: string; decimals: number | null; verified: boolean }; // a symbol only for a verified token
    program(address: Address): string;
    priorityFee: bigint | null; // lamports the Compute Budget price comes to
    payer: Address;
    changes(address: Address): string[]; // what the simulation changed in an account of yours, in words
    icon?(mint: Address): string | null; // a verified token's logo
};

const AUTHORITY: Record<string, string> = { 0: 'The right to mint', 1: 'The right to freeze', 2: 'The ownership', 3: 'The right to close' };

/** One explained instruction → its story. `risky`: its program may be harmful, so what it does to you shows in red. */
export function story(e: Explained, n: Names, risky = false): Story {
    const arg = (name: string) => e.args.find((a) => a.name === name)?.value ?? '';
    const acc = (role: string) => e.accounts.find((a) => a.role === role)?.address;
    const big = (name: string) => (/^\d+$/.test(arg(name)) ? BigInt(arg(name)) : 0n);
    const who = (a: Address | undefined) => (a ? n.who(a) : 'an account');
    const Who = (a: Address | undefined) => cap(who(a));
    const tokens = (units: bigint, mint: Address | null, decimals?: number) => {
        const t = n.token(mint);
        const places = decimals ?? t.decimals;
        return `${places === null ? `${units} units of` : amount(units, places, false)} ${t.symbol}`;
    };
    const line = (text: string, tone: Tone = 'plain'): Effect => ({ text, tone });
    const hurts = (a: Address | undefined) => (a && n.mine(a) ? (risky ? 'danger' : 'warn') : 'plain');

    if (e.source === 'unknown') return unknown(e, n, risky);
    if (e.program === SYSTEM_PROGRAM_ADDRESS) {
        switch (e.name) {
            case 'TransferSol': {
                const [from, to] = [acc('source'), acc('destination')];
                return { args: `${sol(big('amount'))} SOL → ${who(to)}`, effects: [line(`${sol(big('amount'))} SOL from ${who(from)} to ${who(to)}`, to && n.mine(to) && !(from && n.mine(from)) ? 'ok' : 'plain')] };
            }
            case 'CreateAccount':
            case 'CreateAccountWithSeed':
                return { args: `${who(acc('newAccount'))}, for ${n.program(arg('programAddress') as Address)}`, effects: [line(`Opens ${who(acc('newAccount'))} with ${sol(big('lamports'))} SOL from ${who(acc('payer'))}, for ${n.program(arg('programAddress') as Address)}`)] };
            case 'Assign':
            case 'AssignWithSeed':
                return { args: `${Who(acc('account'))} → ${n.program(arg('programAddress') as Address)}`, effects: [line(`Gives ${who(acc('account'))} to ${n.program(arg('programAddress') as Address)}`, acc('account') && n.mine(acc('account')!) ? 'danger' : 'plain')] };
            case 'Allocate':
            case 'AllocateWithSeed':
                return { args: `${arg('space')} bytes`, effects: [line(`Gives ${who(acc('newAccount'))} room for ${arg('space')} bytes`)] };
            case 'AdvanceNonceAccount':
                return { args: who(acc('nonceAccount')), effects: [line('Uses a durable nonce: this transaction never expires', 'danger')] };
            case 'WithdrawNonceAccount':
                return { args: `${sol(big('withdrawAmount'))} SOL`, effects: [line(`${sol(big('withdrawAmount'))} SOL from ${who(acc('nonceAccount'))} to ${who(acc('recipientAccount'))}`)] };
            case 'AuthorizeNonceAccount':
                return { args: `→ ${who(arg('newNonceAuthority') as Address)}`, effects: [line(`The nonce of ${who(acc('nonceAccount'))} now answers to ${who(arg('newNonceAuthority') as Address)}`, hurts(acc('nonceAccount')))] };
        }
    }
    if (TOKEN_PROGRAMS.includes(e.program)) {
        const mint = acc('mint') ?? n.mintOf(acc('source') ?? acc('account') ?? acc('token') ?? acc('owned') ?? acc('destination') ?? ('' as Address));
        const decimals = /^\d+$/.test(arg('decimals')) ? Number(arg('decimals')) : undefined;
        switch (e.name) {
            case 'Transfer':
            case 'TransferChecked': {
                const [from, to] = [acc('source'), acc('destination')];
                return { args: `${tokens(big('amount'), mint, decimals)} → ${who(to)}`, effects: [line(`${tokens(big('amount'), mint, decimals)} from ${who(from)} to ${who(to)}`, to && n.mine(to) && !(from && n.mine(from)) ? 'ok' : hurts(from) === 'danger' ? 'danger' : 'plain')] };
            }
            case 'Approve':
            case 'ApproveChecked':
                return { args: `${who(acc('delegate'))}, up to ${tokens(big('amount'), mint, decimals)}`, effects: [line(`${Who(acc('delegate'))} may move up to ${tokens(big('amount'), mint, decimals)} from ${who(acc('source'))}`, hurts(acc('source')))] };
            case 'Revoke':
                return { args: who(acc('source')), effects: [line(`Takes back any allowance on ${who(acc('source'))}`, 'ok')] };
            case 'SetAuthority': {
                const to = arg('newAuthority');
                const right = AUTHORITY[arg('authorityType')] ?? 'An authority';
                return { args: `${right.replace(/^The /, '')} → ${to === 'none' ? 'nobody' : who(to as Address)}`, effects: [line(`${right} of ${who(acc('owned'))} goes to ${to === 'none' ? 'nobody' : who(to as Address)}`, to !== n.wallet ? hurts(acc('owned')) === 'plain' ? 'plain' : 'danger' : 'plain')] };
            }
            case 'CloseAccount': {
                const [account, to] = [acc('account'), acc('destination')];
                return { args: `${Who(account)} → ${who(to)}`, effects: [line(`Closes ${who(account)}; its SOL goes to ${who(to)}`, to && n.mine(to) ? 'plain' : hurts(account))] };
            }
            case 'SyncNative':
                return { args: Who(acc('account')), effects: [line(`Counts the SOL in ${who(acc('account'))} as wrapped SOL`)] };
            case 'MintTo':
            case 'MintToChecked':
                return { args: `${tokens(big('amount'), mint, decimals)} → ${who(acc('token'))}`, effects: [line(`Mints ${tokens(big('amount'), mint, decimals)} to ${who(acc('token'))}`, acc('token') && n.mine(acc('token')!) ? 'ok' : 'plain')] };
            case 'Burn':
            case 'BurnChecked':
                return { args: tokens(big('amount'), mint, decimals), effects: [line(`Burns ${tokens(big('amount'), mint, decimals)} from ${who(acc('account'))}`, hurts(acc('account')))] };
            case 'InitializeAccount':
            case 'InitializeAccount2':
            case 'InitializeAccount3':
                return { args: Who(acc('account')), effects: [line(`Sets up ${who(acc('account'))} for ${n.token(mint).symbol}`)] };
            case 'FreezeAccount':
            case 'ThawAccount':
                return { args: Who(acc('account')), effects: [line(`${e.name === 'FreezeAccount' ? 'Freezes' : 'Thaws'} ${who(acc('account'))}`, e.name === 'FreezeAccount' ? hurts(acc('account')) : 'plain')] };
        }
    }
    if (e.program === ASSOCIATED_TOKEN_PROGRAM_ADDRESS && e.name.startsWith('CreateAssociatedToken')) {
        const [ata, owner, mint] = [acc('ata'), acc('owner'), acc('mint')];
        const what = `${owner && owner === n.wallet ? 'your' : `${who(owner)}'s`} ${n.token(mint ?? null).symbol} account`;
        const back = owner && owner === n.wallet ? 'the rent comes back when it closes' : 'the rent is theirs when they close it';
        const effects = ata && n.existed(ata) ? [line(`${cap(what)} is there already: nothing changes`)] : [line(`Opens ${what}, paid by ${who(acc('payer'))}; ${back}`)];
        return { args: cap(what), effects };
    }
    if (e.program === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
        switch (e.name) {
            case 'SetComputeUnitLimit':
                return { args: `${Number(arg('units')).toLocaleString('en-US')} CU`, effects: [line(`Caps compute at ${Number(arg('units')).toLocaleString('en-US')} units`)] };
            case 'SetComputeUnitPrice':
                return { args: `${Number(arg('microLamports')).toLocaleString('en-US')} µlamports/CU`, effects: [line(n.priorityFee === null ? 'Sets a priority fee' : `Priority fee ${sol(n.priorityFee)} SOL, paid by ${who(n.payer)}`)] };
            case 'RequestHeapFrame':
                return { args: `${Number(arg('bytes')) / 1024} KB`, effects: [line(`Asks for ${Number(arg('bytes')) / 1024} KB of memory`)] };
            case 'SetLoadedAccountsDataSizeLimit':
                return { args: `${Number(arg('accountDataSizeLimit')).toLocaleString('en-US')} bytes`, effects: [line('Caps how much account data it may load')] };
        }
    }
    if ([MEMO_PROGRAM_ADDRESS, LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3].includes(e.program as never)) {
        return { args: `“${clean(arg('memo'))}”`, effects: [line('Writes a note in the transaction log')] };
    }
    return { args: e.args.map((a) => `${a.name} ${clean(a.value)}`).join(' · '), effects: [] };
}

// Text a transaction carries, as a seed: no characters that reorder or hide what is shown, and short.
const clean = (s: string) => {
    const text = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
    return text.length > 48 ? `${text.slice(0, 47)}…` : text;
};

// An instruction no plugin reads: its data in short, and what the simulation changed in your accounts it touches.
function unknown(e: Explained, n: Names, risky: boolean): Story {
    const touched = [...new Set(e.accounts.map((a) => a.address))].filter((a) => n.mine(a));
    // What comes to you is never what harms you: only what leaves shows red.
    const effects = touched.flatMap((a) => n.changes(a)).map((text) => ({ text, tone: (text.startsWith('+') ? 'ok' : risky ? 'danger' : 'plain') as Tone }));
    return { args: e.data ? `No plugin reads it · data ${hex(e.data)}` : 'No plugin reads it', effects: effects.length ? effects : [{ text: touched.length ? 'Nothing of yours changes in the simulation' : 'Touches nothing of yours', tone: 'plain' }] };
}

const hex = (data: ReadonlyUint8Array) => (data.length === 0 ? 'none' : `0x${[...data.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')}${data.length > 4 ? '…' : ''} · ${data.length} bytes`);

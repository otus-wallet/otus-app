import {
    COMPUTE_BUDGET_PROGRAM_ADDRESS,
    ComputeBudgetInstruction,
    parseComputeBudgetInstruction,
} from '@solana-program/compute-budget';
import { LEGACY_MEMO_PROGRAM_ADDRESS_V1, LEGACY_MEMO_PROGRAM_ADDRESS_V3, MEMO_PROGRAM_ADDRESS, parseAddMemoInstruction } from '@solana-program/memo';
import { parseSystemInstruction, SYSTEM_PROGRAM_ADDRESS, SystemInstruction } from '@solana-program/system';
import {
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    AssociatedTokenInstruction,
    parseAssociatedTokenInstruction,
    parseTokenInstruction,
    TOKEN_PROGRAM_ADDRESS,
    TokenInstruction,
} from '@solana-program/token';

import type { Address } from '@solana/kit';

import { TOKEN_2022_PROGRAM_ADDRESS } from './addresses.ts';
import { codamaPlugin, type KitInstruction, type Plugin } from './plugin.ts';

export { TOKEN_2022_PROGRAM_ADDRESS };

// Token-2022 encodes its base instructions (0 to 24, and 38) as Token does. Its extension instructions stay unknown
// for now, rather than read as the Token instructions that reuse their numbers.
function parseToken2022Instruction(instruction: KitInstruction) {
    const kind = instruction.data[0];
    if (kind > 24 && kind !== 38) throw new Error('a Token-2022 extension instruction');
    return parseTokenInstruction(instruction);
}

/** The programs almost every transaction touches, explained by Solana's own generated clients. */
export const CORE_PLUGINS: Plugin[] = [
    codamaPlugin(SYSTEM_PROGRAM_ADDRESS, 'System Program', parseSystemInstruction, (t) => SystemInstruction[t]),
    codamaPlugin(COMPUTE_BUDGET_PROGRAM_ADDRESS, 'Compute Budget', parseComputeBudgetInstruction, (t) => ComputeBudgetInstruction[t]),
    codamaPlugin(TOKEN_PROGRAM_ADDRESS, 'Token Program', parseTokenInstruction, (t) => TokenInstruction[t]),
    codamaPlugin(TOKEN_2022_PROGRAM_ADDRESS, 'Token-2022', parseToken2022Instruction, (t) => TokenInstruction[t]),
    codamaPlugin(ASSOCIATED_TOKEN_PROGRAM_ADDRESS, 'Associated Token', parseAssociatedTokenInstruction, (t) => AssociatedTokenInstruction[t]),
    // The Memo program most sites use (MemoSq…fcHr; the client calls it legacy v3), its newer deploy, and the first one.
    codamaPlugin(LEGACY_MEMO_PROGRAM_ADDRESS_V3, 'Memo', parseAddMemoInstruction, () => 'AddMemo'),
    codamaPlugin(MEMO_PROGRAM_ADDRESS, 'Memo', parseAddMemoInstruction, () => 'AddMemo'),
    codamaPlugin(LEGACY_MEMO_PROGRAM_ADDRESS_V1, 'Memo (legacy)', parseAddMemoInstruction, () => 'AddMemo'),
];

/** The programs the core plugins read: Solana's own, the token programs, memo. */
export const CORE_PROGRAMS: ReadonlySet<Address> = new Set(CORE_PLUGINS.map((p) => p.program));

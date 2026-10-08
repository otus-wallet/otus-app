import type { AccountMeta, Address, Instruction, InstructionWithData, ReadonlyUint8Array } from '@solana/kit';

export type KitInstruction = Instruction & InstructionWithData<ReadonlyUint8Array>;

/** What a plugin says about one instruction. */
export type Explanation = {
    name: string;
    accounts: { role: string; address: Address }[];
    args: { name: string; value: string }[];
};

/** One plugin per program. Pure: it reads only the instruction it is given. */
export type Plugin = {
    program: Address;
    name: string;
    explain(instruction: KitInstruction): Explanation | null; // null: an instruction it does not know
};

type Parsed = { instructionType?: number; accounts?: Record<string, AccountMeta | undefined>; data?: object };

/** A plugin over a Codama-generated client, whose parser names the instruction, its accounts and its data. */
export function codamaPlugin(
    program: Address,
    name: string,
    parse: (instruction: KitInstruction) => Parsed,
    nameOf: (instructionType: number) => string,
): Plugin {
    return {
        program,
        name,
        explain(instruction) {
            const parsed = parse(instruction);
            const named = Object.entries(parsed.accounts ?? {});
            const extra = (instruction.accounts ?? []).slice(named.length);
            return {
                name: nameOf(parsed.instructionType ?? 0),
                accounts: [
                    ...named.flatMap(([role, meta]) => (meta ? [{ role, address: meta.address }] : [])),
                    ...extra.map((meta, i) => ({ role: `account ${named.length + i + 1}`, address: meta.address })),
                ],
                args: Object.entries(parsed.data ?? {})
                    .filter(([key]) => key !== 'discriminator')
                    .map(([key, value]) => ({ name: key, value: show(value) })),
            };
        },
    };
}

/** A decoded value for display: numbers as digits, bytes as hex, options as their value or "none". Text comes from
 *  whoever made the transaction: without characters that reorder or hide what is shown, and capped. */
export function show(v: unknown): string {
    if (v instanceof Uint8Array) return cap([...v].map((b) => b.toString(16).padStart(2, '0')).join(''));
    if (Array.isArray(v)) return cap(`[${v.map(show).join(', ')}]`);
    if (typeof v === 'object' && v !== null) {
        if ('__option' in v) return 'value' in v ? show(v.value) : 'none';
        return cap(`{ ${Object.entries(v).map(([k, x]) => `${k}: ${show(x)}`).join(', ')} }`);
    }
    return cap(String(v).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' '));
}

const MAX_SHOWN = 200;
const cap = (s: string) => (s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN - 1)}…` : s);

// An instruction no plugin reads, told with its program's own IDL: which of the IDL's instructions it is, by its
// discriminator; its arguments; and what the IDL calls each of its accounts. An IDL can describe types that would take
// forever to build a reader for, or to read: an instruction's types are measured first, and refused past a size, or
// where a list could go on without reading a byte. Names come from the program, so they are cleaned and kept short.
import { getNodeCodecVisitor, getValueNodeVisitor } from '@codama/dynamic-codecs';
import { isNode, pascalCase, VALUE_NODE_KINDS, type InstructionNode, type ProgramNode, type RootNode } from '@codama/nodes';
import { getRecordLinkablesVisitor, LinkableDictionary, NodeStack, visit } from '@codama/visitors-core';
import { isAddress, type Address, type ReadonlyUint8Array } from '@solana/kit';

import { short } from '../format.ts';
import type { Idl, Source } from './read.ts';

/** An instruction as its program's IDL tells it. `program`: what the IDL calls the program; `from`: where it was. */
export type IdlInstruction = { name: string; args: string; accounts: { role: string; address: Address }[]; program: string; from: Source };

const MAX_NODES = 2_000; // type nodes one instruction may come to, each link to a defined type followed where it is
const MAX_LINKS = 24; // links within links
const SHOWN = 6; // arguments shown, the discriminator aside
const NAME = 48; // characters of a name
const TEXT = 24; // characters of a text value

/** The first of these IDLs that knows this instruction → how it tells it; null when none does. Never throws. */
export function tellWith(idls: Idl[], data: ReadonlyUint8Array, accounts: Address[]): IdlInstruction | null {
    for (const idl of idls) {
        try {
            const told = tell(idl, data, accounts);
            if (told) return told;
        } catch {} // an IDL that breaks tells nothing
    }
    return null;
}

// What an IDL's types link to, recorded once per IDL.
const recorded = new WeakMap<RootNode, LinkableDictionary>();
function linkablesOf(root: RootNode): LinkableDictionary {
    let linkables = recorded.get(root);
    if (!linkables) {
        linkables = new LinkableDictionary();
        visit(root, getRecordLinkablesVisitor(linkables));
        recorded.set(root, linkables);
    }
    return linkables;
}

function tell({ root, from }: Idl, data: ReadonlyUint8Array, accounts: Address[]): IdlInstruction | null {
    const program = root.program;
    const linkables = linkablesOf(root);
    for (const instruction of program.instructions ?? []) {
        if (!instruction.discriminators?.length || !bounded(program, instruction)) continue;
        const stack = new NodeStack([root, program, instruction]);
        const codecs = getNodeCodecVisitor(linkables, { stack });
        const values = getValueNodeVisitor(linkables, { stack });
        if (!matches(instruction, data, codecs, values)) continue;
        const decoded = visit(instruction, getNodeCodecVisitor(linkables, { stack: new NodeStack([root, program]) })).decode(data) as Record<string, unknown>;
        const name = clean(pascalCase(instruction.name.normalize('NFKC'))); // Codama keeps letters and digits of a-z alone
        if (!name) return null;
        return { name, args: argsOf(instruction, decoded), accounts: accountsOf(instruction, accounts), program: plain(program.name) ?? '', from };
    }
    return null;
}

type Codecs = ReturnType<typeof getNodeCodecVisitor>;
type Values = ReturnType<typeof getValueNodeVisitor>;

// Whether the data starts as this instruction's discriminators say: a field's default value at its offset, a constant at
// its offset, or a size. An instruction with no discriminator cannot be told apart, and is never matched.
function matches(instruction: InstructionNode, data: ReadonlyUint8Array, codecs: Codecs, values: Values): boolean {
    return (instruction.discriminators ?? []).every((d) => {
        if (d.kind === 'sizeDiscriminatorNode') return data.length === d.size;
        if (d.kind === 'constantDiscriminatorNode') return at(data, visit(d.constant.type, codecs).encode(visit(d.constant.value, values)), d.offset);
        const field = (instruction.arguments ?? []).find((a) => a.name === d.name);
        return isNode(field?.defaultValue, VALUE_NODE_KINDS) && at(data, visit(field.type, codecs).encode(visit(field.defaultValue, values)), d.offset);
    });
}

const at = (data: ReadonlyUint8Array, bytes: ReadonlyUint8Array, offset: number) => offset + bytes.length <= data.length && bytes.every((b, i) => data[offset + i] === b);

// Its arguments in a line, the discriminators aside: each name and its value, a few of them, single values before
// what holds several.
function argsOf(instruction: InstructionNode, decoded: Record<string, unknown>): string {
    const fields = new Set((instruction.discriminators ?? []).flatMap((d) => (d.kind === 'fieldDiscriminatorNode' ? [d.name] : [])));
    const args = (instruction.arguments ?? []).filter((a) => !fields.has(a.name));
    const several = (v: unknown) => typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && (v as { __option?: unknown }).__option === undefined;
    const ordered = args.toSorted((a, b) => Number(several(decoded[a.name])) - Number(several(decoded[b.name])));
    const words = ordered.slice(0, SHOWN).map((a) => `${clean(a.name)} ${shown(decoded[a.name])}`);
    return [...words, ...(args.length > SHOWN ? [`+${args.length - SHOWN} more`] : [])].join(' · ');
}

// What the IDL calls each account, by its place. Past its list, or past an optional account it may have left out
// (where the IDL says those are omitted, not filled with the program's address), an account goes by its number.
function accountsOf(instruction: InstructionNode, accounts: Address[]): IdlInstruction['accounts'] {
    const named = (instruction.accounts ?? []).map((a) => clean(a.name));
    const optional = (instruction.accounts ?? []).findIndex((a) => a.isOptional);
    const shifted = instruction.optionalAccountStrategy === 'omitted' && optional >= 0 && accounts.length !== named.length;
    return accounts.map((address, i) => ({ role: (shifted && i >= optional) || i >= named.length ? `account ${i + 1}` : named[i], address }));
}

// Whether the reader of an instruction stays small and comes to an end. Only what the reader is built from is walked:
// the types of the instruction's arguments, and of its constant discriminators. Their nodes are counted up to a bound,
// each link to a defined type followed where it appears, as the reader follows it; a link Otus cannot follow here
// (to another program, or of another kind) refuses it, as does an offset, which can move the reader back, and a list
// of things that can take no bytes, which a count could make go on without reading one.
function bounded(program: ProgramNode, instruction: InstructionNode): boolean {
    const types = new Map<string, unknown>((program.definedTypes ?? []).map((t) => [t.name, t.type]));
    const empty = emptiness(types);
    let nodes = 0;
    const fits = (node: unknown, links: number): boolean => {
        if (Array.isArray(node)) return node.every((n) => fits(n, links));
        if (!node || typeof node !== 'object') return true;
        if (++nodes > MAX_NODES || links > MAX_LINKS) return false;
        const n = node as { kind?: unknown; name?: unknown; program?: unknown; item?: unknown; key?: unknown; value?: unknown };
        const kind = typeof n.kind === 'string' ? n.kind : '';
        if (kind === 'definedTypeLinkNode') {
            const type = n.program === undefined && typeof n.name === 'string' ? types.get(n.name) : undefined;
            return type !== undefined && fits(type, links + 1);
        }
        if (kind.endsWith('LinkNode') || kind === 'preOffsetTypeNode' || kind === 'postOffsetTypeNode') return false;
        if ((kind === 'arrayTypeNode' || kind === 'setTypeNode') && empty(n.item)) return false;
        if (kind === 'mapTypeNode' && empty(n.key) && empty(n.value)) return false;
        return Object.values(n).every((v) => fits(v, links));
    };
    const constants = (instruction.discriminators ?? []).flatMap((d) => (d.kind === 'constantDiscriminatorNode' ? [d.constant] : []));
    return fits([...(instruction.arguments ?? []).map((a) => a.type), ...constants], 0);
}

// Whether a value of a type can take no bytes. In doubt, it can: bytes or a text to the end, an option to the end, a
// link that leads nowhere, a kind not known here, what nests too deep. Each defined type is worked out once, and
// counts as able to while it is (a type within itself).
function emptiness(types: Map<string, unknown>): (type: unknown) => boolean {
    const worked = new Map<string, boolean>();
    const empty = (type: unknown, depth = 0): boolean => {
        if (!type || typeof type !== 'object' || depth > MAX_LINKS) return true;
        const t = type as { kind?: unknown; name?: unknown; size?: unknown; fields?: unknown; items?: unknown; item?: unknown; type?: unknown; key?: unknown; value?: unknown; count?: { kind?: unknown; value?: unknown } };
        const all = (list: unknown) => (Array.isArray(list) ? list : []).every((x: { type?: unknown } | unknown) => empty(t.kind === 'structTypeNode' ? (x as { type?: unknown })?.type : x, depth + 1));
        switch (t.kind) {
            case 'numberTypeNode':
            case 'booleanTypeNode':
            case 'publicKeyTypeNode':
            case 'amountTypeNode':
            case 'solAmountTypeNode':
            case 'dateTimeTypeNode':
            case 'enumTypeNode': // its variant comes first, in a number
            case 'optionTypeNode': // whether it holds one comes first
            case 'sizePrefixTypeNode':
                return false;
            case 'fixedSizeTypeNode':
                return t.size === 0;
            case 'structTypeNode':
                return all(t.fields); // a struct with no fields is written with none
            case 'tupleTypeNode':
                return all(t.items);
            case 'zeroableOptionTypeNode':
            case 'hiddenPrefixTypeNode':
            case 'hiddenSuffixTypeNode':
            case 'sentinelTypeNode':
                return empty(t.item ?? t.type, depth + 1);
            case 'arrayTypeNode':
            case 'setTypeNode':
            case 'mapTypeNode': {
                if (t.count?.kind === 'prefixedCountNode') return false;
                if (t.count?.kind !== 'fixedCountNode' || t.count.value === 0) return true;
                return t.kind === 'mapTypeNode' ? empty(t.key, depth + 1) && empty(t.value, depth + 1) : empty(t.item, depth + 1);
            }
            case 'definedTypeLinkNode': {
                const name = String(t.name);
                const known = worked.get(name);
                if (known !== undefined) return known;
                worked.set(name, true);
                const result = empty(types.get(name), depth + 1);
                worked.set(name, result);
                return result;
            }
            default:
                return true;
        }
    };
    return empty;
}

// A decoded value in a few words: a number as it is, an address short, bytes by their size, what nests a level in.
function shown(value: unknown, depth = 0): string {
    if (typeof value === 'bigint' || typeof value === 'number') return Number.isInteger(value) || typeof value === 'bigint' ? value.toLocaleString('en-US') : String(value);
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'string') return isAddress(value) ? short(value) : `"${clean(value, TEXT)}"`;
    if (value === null || value === undefined) return 'none';
    if (value instanceof Uint8Array) return `${value.length} bytes`;
    if (value instanceof Map) return `{${value.size} entries}`;
    if (Array.isArray(value)) return listed(value, depth);
    if (typeof value !== 'object') return '?';
    const o = value as Record<string, unknown>;
    if (o.__option === 'None') return 'none';
    if (o.__option === 'Some') return shown(o.value, depth);
    const rest = Object.entries(o).filter(([k]) => k !== '__kind');
    const kind = typeof o.__kind === 'string' ? clean(o.__kind) : null;
    if (kind && (rest.length === 0 || depth > 0)) return kind;
    return [kind, depth > 1 ? '{…}' : `{${rest.slice(0, 3).map(([k, v]) => `${clean(k)} ${shown(v, depth + 1)}`).join(', ')}${rest.length > 3 ? ', …' : ''}}`].filter(Boolean).join(' ');
}

// A list: a few of its items, how many more. Bytes, as Codama gives them or as a list of them, by their number.
function listed(items: unknown[], depth: number): string {
    if (items.length === 2 && typeof items[0] === 'string' && ['base16', 'base58', 'base64', 'utf8'].includes(items[0]) && typeof items[1] === 'string') return 'bytes';
    if (items.length > 4 && items.every((b) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255)) return `${items.length} bytes`;
    if (depth > 1) return `[${items.length}]`;
    return `[${items.slice(0, 3).map((v) => shown(v, depth + 1)).join(', ')}${items.length > 3 ? `, +${items.length - 3}` : ''}]`;
}

// A program's name as an IDL gives it, when it is plain: letters, digits, spaces, _ and -, once compatibility forms
// are folded ("Ｊｕｐｉｔｅｒ" is Jupiter), and kept short; null otherwise, as a letter from another script can pass
// for one ("Jupitеr" with a Cyrillic е).
function plain(name: string): string | null {
    const folded = name.normalize('NFKC').trim();
    return /^[A-Za-z0-9 _-]+$/.test(folded) ? clean(folded) : null;
}

// A name or text from an IDL, as shown: without characters that move or hide others, within a length.
function clean(text: string, max = NAME): string {
    const plain = text.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim();
    return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

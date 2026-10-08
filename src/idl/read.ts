// A program's IDL, as the program publishes it on chain, from either of two places:
// - the Program Metadata Program's canonical "idl" account for it, which only the program's upgrade authority writes;
// - Anchor's IDL account, at an address derived from the program, which only the program itself writes.
// Either way it is the program's own word about itself: what it calls its instructions, their arguments and their
// accounts. Otus shows it as such and never counts it toward a verdict. An account's data is read as an attacker's
// until it proves otherwise: by its owner and layout, within a size, inflated within another.
import type { RootNode } from '@codama/nodes';
import { rootNodeFromAnchorWithoutDefaultVisitor, type AnchorIdl } from '@codama/nodes-from-anchor';
import { createAddressWithSeed, fixEncoderSize, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, getUtf8Encoder, type Address, type MaybeEncodedAccount } from '@solana/kit';

export const PROGRAM_METADATA = 'ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S' as Address;

/** Where an IDL was published: the program's canonical metadata, or Anchor's IDL account. */
export type Source = 'metadata' | 'anchor';

/** A program's IDL, as a Codama tree, and where it was published. */
export type Idl = { root: RootNode; from: Source };

const MAX_STORED = 512 * 1024; // bytes an IDL may take as stored, compressed
const MAX_TEXT = 2 * 1024 * 1024; // bytes once inflated; the largest seen on mainnet, Marginfi's, is under 500 KB
const ANCHOR_IDL = [24, 70, 98, 191, 58, 144, 123, 158]; // Anchor's IdlAccount: sha256("internal:IdlAccount"), first 8 bytes
const METADATA = 2; // the Program Metadata Program's discriminator for a metadata account
const COMPRESSION = [null, 'gzip', 'deflate'] as const; // its none, gzip and zlib; 'deflate' is zlib's wrapper in a browser

/** Where a program's IDL may be: its canonical metadata account (seeds: the program, "idl"), and Anchor's IDL account
 *  (created with the seed "anchor:idl" from the program's own address with no seeds). */
export async function idlAddresses(program: Address): Promise<Record<Source, Address>> {
    const seed = fixEncoderSize(getUtf8Encoder(), 16).encode('idl');
    const [metadata] = await getProgramDerivedAddress({ programAddress: PROGRAM_METADATA, seeds: [getAddressEncoder().encode(program), seed] });
    const [base] = await getProgramDerivedAddress({ programAddress: program, seeds: [] });
    const anchor = await createAddressWithSeed({ baseAddress: base, programAddress: program, seed: 'anchor:idl' });
    return { metadata, anchor };
}

/** An account where `program` may publish its IDL → the IDL, or null for anything that is not one. Never throws. */
export async function readIdl(account: MaybeEncodedAccount, from: Source, program: Address): Promise<Idl | null> {
    if (!account.exists) return null;
    const stored = from === 'metadata' ? (account.programAddress === PROGRAM_METADATA ? metadataIdl(account.data, program) : null) : account.programAddress === program ? anchorIdl(account.data) : null;
    if (!stored) return null;
    const text = stored.compression ? await inflated(stored.bytes, stored.compression) : stored.bytes;
    if (!text) return null;
    const root = rootOf(text);
    return root && { root, from };
}

type Stored = { bytes: Uint8Array; compression: 'gzip' | 'deflate' | null };

// A canonical metadata account, for this very program and seed: discriminator, program, authority (zeroes for none),
// mutable, canonical, a 16-byte seed; then how its data is held: encoding, compression, format, data source, and its
// length (a u32 padded to 9 bytes); then the data. Only UTF-8 text held in the account itself is read, never a URL or
// another account: what an IDL points to is not fetched.
function metadataIdl(data: Uint8Array, program: Address): Stored | null {
    if (data.length < 96 || data[0] !== METADATA || data[66] !== 1) return null;
    if (getAddressDecoder().decode(data.subarray(1, 33)) !== program) return null;
    if (!data.subarray(67, 83).every((b, i) => b === (i < 3 ? 'idl'.charCodeAt(i) : 0))) return null;
    const [encoding, compression, format, source] = data.subarray(83, 87);
    if (encoding !== 1 || source !== 0 || format > 1 || compression > 2) return null; // UTF-8, here, JSON or unsaid
    const length = u32(data, 87);
    if (length > MAX_STORED || 96 + length > data.length) return null;
    return { bytes: data.subarray(96, 96 + length), compression: COMPRESSION[compression] };
}

// Anchor's IDL account: its discriminator, its authority, the length of the data (u32), then the data, zlib.
function anchorIdl(data: Uint8Array): Stored | null {
    if (data.length < 44 || !ANCHOR_IDL.every((b, i) => data[i] === b)) return null;
    const length = u32(data, 40);
    if (length > MAX_STORED || 44 + length > data.length) return null;
    return { bytes: data.subarray(44, 44 + length), compression: 'deflate' };
}

const u32 = (data: Uint8Array, at: number) => new DataView(data.buffer, data.byteOffset + at, 4).getUint32(0, true);

// Inflated with the browser's own decompression, given up past `MAX_TEXT` bytes: a small account can hold a bomb.
async function inflated(bytes: Uint8Array, how: 'gzip' | 'deflate'): Promise<Uint8Array | null> {
    const reader = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream(how)).getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > MAX_TEXT) {
                await reader.cancel().catch(() => {});
                return null;
            }
            parts.push(value);
        }
    } catch {
        return null; // not what it says it is
    }
    const out = new Uint8Array(size);
    parts.reduce((at, part) => (out.set(part, at), at + part.length), 0);
    return out;
}

// An IDL's text → its Codama tree: Anchor's, of either spec, converted as it is (without the passes that ready a tree
// for a client: none is needed to read an instruction); Codama's own, as it is. Anything else, or anything that does
// not convert, is no IDL. An Anchor IDL with generic types is no IDL either: Codama writes a generic type out again at
// each use, so a few hundred bytes of them nesting can come to millions of nodes, built at once, before anything can
// measure them. No published IDL seen on mainnet has one.
function rootOf(text: Uint8Array): RootNode | null {
    try {
        const idl: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(text));
        if (!idl || typeof idl !== 'object') return null;
        const o = idl as { kind?: unknown; standard?: unknown; program?: { kind?: unknown }; instructions?: unknown };
        if (o.kind === 'rootNode' && o.standard === 'codama' && o.program?.kind === 'programNode') return idl as RootNode;
        if (!Array.isArray(o.instructions)) return null;
        const types = (idl as { types?: unknown }).types;
        if (Array.isArray(types) && types.some((t) => t !== null && typeof t === 'object' && 'generics' in t)) return null;
        return rootNodeFromAnchorWithoutDefaultVisitor(idl as AnchorIdl);
    } catch {
        return null;
    }
}

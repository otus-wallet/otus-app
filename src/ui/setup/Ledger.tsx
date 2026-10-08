// A Ledger's accounts, added to Otus. Chrome's chooser grants Otus a device (only from a tab, so only here), and lists
// the ones granted already, so each Connect asks which: another Ledger may be plugged in. Every address comes from the
// device, never from Otus. The ones with SOL show first, picked; the empty ones on request.
import { isAddress, type Address } from '@solana/kit';
import { useRef, useState } from 'react';

import { pair, talkTo, type HidDevice } from '../../ledger/devices.ts';
import { LedgerError } from '../../ledger/hid.ts';
import { address, solanaApp } from '../../ledger/solana.ts';
import { sol } from '@otus-wallet/sdk/format';
import { rpcAt } from '@otus-wallet/sdk/rpc';
import { rpcFor } from '../../settings.ts';
import { load, nameTaken, signs, type Account, type State } from '../../shell/state.ts';
import { Checkbox } from '../components/ui/checkbox.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Tile } from '../components/icons.tsx';
import { short } from '../dom.ts';
import type { Page } from './Setup.tsx';
import { ErrorLine, Lead, Muted, Row, Soft } from './parts.tsx';

// Where wallets keep Ledger accounts: Phantom, Solflare and Backpack's n'/0', Ledger Live's n' and n'/0'/0', Solflare
// and older Backpack's 0'/0'/n' and 0'/n', and the root. The first ten of each are read; a missing one is looked for
// further, by its address.
const SCHEMES = [(n: number) => `44'/501'/${n}'/0'`, (n: number) => `44'/501'/${n}'`, (n: number) => `44'/501'/0'/0'/${n}'`, (n: number) => `44'/501'/${n}'/0'/0'`, (n: number) => `44'/501'/0'/${n}'`];
const ROOT = "44'/501'";
const FIRST = 10;
const DEEP = 50;
const MAIN = "44'/501'/0'/0'"; // the first account most wallets make

/** The paths of accounts `from` to `to` of every kind, in that order; the root first. */
const paths = (from: number, to: number) => [...(from === 0 ? [ROOT] : []), ...Array.from({ length: to - from }, (_, i) => SCHEMES.map((s) => s(from + i))).flat()];

type Found = { path: string; address: Address; lamports: bigint | null };

export function LedgerAccounts({ state, go, finished }: { state: State; go: (to: Page) => void; finished: (a: Account) => void }) {
    const [found, setFound] = useState<Found[] | null>(null);
    const [picked, setPicked] = useState<Set<Address>>(new Set());
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [read, setRead] = useState<{ done: number; of: number } | null>(null); // how far reading the device has come
    const [all, setAll] = useState(false); // the empty ones shown too
    const [query, setQuery] = useState('');
    const device = useRef<HidDevice | null>(null);
    const [owned, setOwned] = useState(() => new Set(state.accounts.filter(signs).map((a) => a.address))); // and the ones added here
    const had = (a: Address) => owned.has(a);

    // The addresses at these paths, counted as they come; stops at `until`'s.
    const reading = (list: string[], until?: Address) =>
        talkTo(device.current!, async (exchange) => {
            await solanaApp(exchange);
            const out: { path: string; address: Address }[] = [];
            for (const path of list) {
                const at = { path, address: await address(exchange, path) };
                out.push(at);
                setRead({ done: out.length, of: list.length });
                if (at.address === until) break;
            }
            return out;
        });

    const attempt = async (work: () => Promise<void>) => {
        setBusy(true);
        setError('');
        try {
            await work();
        } catch (e) {
            setError(e instanceof LedgerError ? e.message : 'Otus could not reach your Ledger');
        } finally {
            setBusy(false);
            setRead(null);
        }
    };

    const connect = () =>
        attempt(async () => {
            device.current = await pair(); // first, while the click still counts
            if (!device.current) return;
            const rows = await withBalances(await reading(paths(0, FIRST)), state);
            const fresh = rows.filter((r) => !had(r.address));
            const funded = fresh.filter(used);
            setFound(rows);
            setAll(false);
            setPicked(new Set((funded.length ? funded : fresh.filter((r) => r.path === MAIN).slice(0, 1)).map((r) => r.address)));
        });

    // An account not among the first ones: looked for further, by its address.
    const find = () =>
        attempt(async () => {
            const want = query.trim();
            if (!isAddress(want)) return setError('That is not a Solana address');
            if (!found?.some((r) => r.address === want)) {
                const deeper = await reading(paths(FIRST, DEEP), want);
                const hit = deeper.find((r) => r.address === want);
                if (!hit) return setError(`It is not among the first ${DEEP} accounts of each path on this Ledger`);
                const [row] = await withBalances([hit], state);
                setFound((f) => [...(f ?? []), row]);
            }
            setPicked((p) => new Set([...p, want]));
            setQuery('');
        });
    // One after another, each named from the accounts as they are by then; one added is marked so, and not asked again.
    const add = async () => {
        setBusy(true);
        setError('');
        let last: Account | undefined;
        try {
            for (const r of found!.filter((f) => picked.has(f.address) && !had(f.address))) {
                const now = await load();
                if (!now.accounts.some((a) => a.address === r.address && signs(a))) {
                    const reply = (await chrome.runtime.sendMessage({ edit: 'ledger', address: r.address, path: r.path, label: freeName(now) })) as { ok: boolean } | undefined;
                    if (!reply?.ok) return setError(`Otus did not add ${short(r.address)}: it looks like an address you have`);
                }
                last = (await load()).accounts.find((a) => a.address === r.address);
                setOwned((o) => new Set([...o, r.address]));
            }
            if (last) finished(last);
        } catch {
            setError('Otus could not add them: try again');
        } finally {
            setBusy(false);
        }
    };

    const waiting = [...picked].filter((a) => !had(a)).length;
    const toggle = (a: Address, on: boolean) => setPicked((p) => (on ? new Set([...p, a]) : new Set([...p].filter((x) => x !== a))));
    const known = found?.some((r) => r.lamports !== null); // balances to tell the used ones by
    const shown = found?.filter((r) => all || !known || used(r) || had(r.address) || picked.has(r.address)) ?? [];
    const hidden = (found?.length ?? 0) - shown.length;
    return (
        <>
            <Lead>Connect a Ledger</Lead>
            <Soft>{lead(read, found !== null)}</Soft>
            {found && (
                <>
                    <ul className="flex flex-col gap-1.5">
                        {shown.map((r) => (
                            <li key={r.path}>
                                <label className="flex cursor-pointer items-center gap-3 rounded-[3px] border border-rule bg-panel px-3 py-2 has-[:disabled]:cursor-default has-[:disabled]:opacity-60">
                                    <Checkbox checked={had(r.address) || picked.has(r.address)} disabled={had(r.address)} onCheckedChange={(v) => toggle(r.address, v === true)} aria-label={r.address} />
                                    <Tile address={r.address} size={28} />
                                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                        <span className="font-bold">{short(r.address)}</span>
                                        <span className="text-[10.5px] text-ink-3">{r.path}</span>
                                    </span>
                                    <span className="text-[11px] text-ink-2">{had(r.address) ? 'In Otus' : r.lamports === null ? '' : `${sol(r.lamports)} SOL`}</span>
                                </label>
                            </li>
                        ))}
                    </ul>
                    {(hidden > 0 || all) && (
                        <button type="button" className="cursor-pointer self-start text-[10.5px] text-ink-2 underline" onClick={() => setAll(!all)}>
                            {all ? 'Hide the empty ones' : `Show the ${hidden} empty ones`}
                        </button>
                    )}
                    {!known && <Muted>Set your RPC in Otus's settings to see their balances.</Muted>}
                    <div className="flex flex-col gap-1.5">
                        <Muted>{`Not here? Paste its address, and Otus looks for it among the first ${DEEP} of each path.`}</Muted>
                        <div className="flex gap-2">
                            <Input placeholder="Solana address" spellCheck={false} autoComplete="off" aria-label="Address to find" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && void find()} />
                            <Button size="sm" disabled={busy || !query.trim()} onClick={() => void find()}>
                                Find
                            </Button>
                        </div>
                    </div>
                </>
            )}
            <ErrorLine>{error}</ErrorLine>
            <Row>
                <Button size="sm" onClick={() => go('start')}>
                    Back
                </Button>
                {found && waiting > 0 ? (
                    <Button size="sm" variant="default" disabled={busy} onClick={() => void add()}>
                        {waiting === 1 ? 'Add it' : `Add ${waiting}`}
                    </Button>
                ) : (
                    <Button size="sm" variant="default" disabled={busy} onClick={() => void connect()}>
                        {found ? 'Connect again' : 'Connect'}
                    </Button>
                )}
            </Row>
        </>
    );
}

const used = (r: Found) => r.lamports !== null && r.lamports > 0n;

// What the page says above all: how far reading the device has come, what to do, or what it found.
function lead(read: { done: number; of: number } | null, found: boolean): string {
    if (read) return `Reading your Ledger's accounts: ${read.done} of ${read.of}`;
    if (!found) return 'Plug in your Ledger, unlock it and open its Solana app. Then connect, and choose it in the list Chrome shows.';
    return 'The accounts with SOL are picked. Wallets keep Ledger accounts on different paths.';
}

// The rows with their SOL; none known when the RPC does not answer.
async function withBalances(rows: { path: string; address: Address }[], state: State): Promise<Found[]> {
    const balances = await lamportsOf(rows.map((r) => r.address), state).catch(() => null);
    return rows.map((r, i) => ({ ...r, lamports: balances?.[i] ?? null }));
}

// Each address's SOL on mainnet, from the RPC set in settings: none for an account that does not exist yet.
async function lamportsOf(addresses: Address[], state: State): Promise<(bigint | null)[]> {
    const rpc = rpcAt(rpcFor('solana:mainnet', state.settings));
    const { value } = await rpc.getMultipleAccounts(addresses, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }).send();
    return value.map((a) => a?.lamports ?? 0n);
}

/** "Ledger 1", or the first number no account or kept address goes by. */
function freeName(state: State): string {
    for (let n = 1; ; n++) if (!nameTaken(state, `Ledger ${n}`)) return `Ledger ${n}`;
}

// The approval window's answers: connect, sign a message, sign in, or a transaction in three steps. It shows what the
// background sends and answers yes or no; it decides nothing itself. It is drawn only while Otus is unlocked: the
// lock is the shield's, over the whole page.
import { useState } from 'react';

import { Tile } from '../components/icons.tsx';
import { YourWallet } from '../components/you.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../components/ui/select.tsx';
import { short } from '../dom.ts';
import type { AccountView, Approval, Life, TransactionView } from '@otus-wallet/core/view.ts';
import { Answer, Block, Frame, Heading, Left, Notice, Steps, useArmed, useNow, WATCH_ONLY } from './Frame.tsx';
import { OnLedger } from './Ledger.tsx';
import { Balances, CopyTransaction, Programs, Verdict } from './Transaction.tsx';

/** No, or yes: for a Ledger account, with the signature its device made (base64); to connect, with another of your
 *  accounts, chosen in the window. */
export type Answers = { answer: (yes: boolean, signature?: string, account?: string) => void };
/** How long the transaction can be signed; for one made in Otus, how to build it again with a fresh blockhash. */
export type Expiry = { from: number; until: number; refresh?: () => void };

/** `life`: its blockhash's, as the network tells it while the user decides: the time left shown, and gone once it says
 *  so. `expiry`: the time left, for Otus's own transfers, whose blockhash it read itself. */
export function Approve({ approval, answers, expiry, life }: { approval: Approval; answers: Answers; expiry?: Expiry; life?: Life }) {
    const [shown] = useState(Date.now);
    const left = expiry ?? (life && 'until' in life ? { from: shown, until: life.until } : undefined);
    const died = life !== undefined && 'expired' in life;
    return (
        <YourWallet.Provider value={approval.account.address}>
            {approval.kind === 'transaction' ? <Transaction t={approval} answers={answers} expiry={left} died={died} /> : <Single a={approval} answers={answers} />}
        </YourWallet.Provider>
    );
}

const WATCH_ONLY_CONNECT = 'Watch only: choose a wallet that signs';

/** What a site may do once connected, a line each. */
const CONNECT_RIGHTS = ['Can see your address', 'Can ask you to sign'];

// A site's rights, as a list.
const Rights = ({ rights }: { rights: string[] }) => (
    <ul className="rights flex flex-col gap-1.5 rounded-[3px] border border-dashed border-rule px-3 py-2.5 text-xs text-ink-2">
        {rights.map((r) => (
            <li key={r} className="flex gap-2">
                <span aria-hidden="true" className="text-ink-3">
                    •
                </span>
                {r}
            </li>
        ))}
    </ul>
);

// Connect, sign a message, sign in: one page each. To connect, the account can be another of yours, chosen on top.
function Single({ a, answers: { answer } }: { a: Exclude<Approval, TransactionView>; answers: Answers }) {
    const signs = a.kind !== 'connect';
    const signer = signs ? a.signer : 'ready';
    const armed = useArmed(a);
    const [chosen, setChosen] = useState(a.account.address);
    const choices = a.kind === 'connect' ? a.choices : [];
    const account = choices.find((c) => c.address === chosen) ?? a.account;
    const watched = a.kind === 'connect' && !choices.some((c) => c.address === account.address); // the one in use only watches
    const yes = () => answer(true, undefined, account.address !== a.account.address ? account.address : undefined);
    return (
        <Frame
            site={a.site}
            account={account}
            picker={(choices.length > 1 || watched) && <AccountPicker choices={choices} shown={account} choose={setChosen} />}
            network={null}
            actions={
                <>
                    <Answer onClick={() => answer(false)}>Reject</Answer>
                    <Answer variant="default" arms armed={armed} disabled={watched || signer === 'none' || (signs && signer === 'ledger')} onClick={yes}>
                        {signs ? 'Sign' : 'Connect'}
                    </Answer>
                </>
            }
        >
            {a.kind === 'connect' ? (
                <>
                    <Block>
                        <Heading>Connect</Heading>
                        <p>{`${a.site.host} asks to see this account.`}</p>
                    </Block>
                    <Rights rights={CONNECT_RIGHTS} />
                    {watched && <Notice>{WATCH_ONLY_CONNECT}</Notice>}
                </>
            ) : a.kind === 'message' ? (
                <Block>
                    <Heading>Message to sign</Heading>
                    <div className="text max-h-[280px] overflow-y-auto rounded-[3px] border border-rule bg-panel px-3 py-2.5 text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">{a.text}</div>
                </Block>
            ) : (
                <Block>
                    <Heading>Sign in</Heading>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                        {a.fields.map(([k, v]) => (
                            <div key={k} className="contents">
                                <dt className="text-ink-3">{k}</dt>
                                <dd className="m-0 [overflow-wrap:anywhere] whitespace-pre-wrap">{v}</dd>
                            </div>
                        ))}
                    </dl>
                </Block>
            )}
            {signer === 'none' && <Notice>{WATCH_ONLY}</Notice>}
            {signs && signer === 'ledger' && <Notice>A Ledger signs transactions only, not messages like this one.</Notice>}
        </Frame>
    );
}

// Your accounts that sign, to connect another than the one in use: the header shows the one chosen (or the watched one in
// use, until another is), and a list under it.
function AccountPicker({ choices, shown, choose }: { choices: AccountView[]; shown: AccountView; choose: (address: string) => void }) {
    return (
        <Select value={choices.some((c) => c.address === shown.address) ? shown.address : ''} onValueChange={choose}>
            <SelectTrigger aria-label="Account to connect" className="h-auto cursor-pointer gap-1.5 border-0 bg-transparent p-0 shadow-none hover:bg-transparent focus-visible:ring-0 dark:bg-transparent dark:hover:bg-transparent">
                <span className="flex flex-col items-end gap-[3px]">
                    <span className="pixel text-xs text-ink">{shown.label}</span>
                    <span className="text-xs text-ink-2">{short(shown.address)}</span>
                </span>
            </SelectTrigger>
            <SelectContent position="popper" align="end" sideOffset={8}>
                {choices.map((c) => (
                    <SelectItem key={c.address} value={c.address} className="text-sm">
                        <span className="flex items-center gap-2">
                            <Tile address={c.address} size={14} />
                            <span className="font-bold">{c.label}</span>
                            <span className="text-ink-3">{short(c.address)}</span>
                        </span>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

// A transaction, in three steps: balances, programs, verdict; a step seen already opens again from the steps. Next
// moves on at once (it approves nothing); Sign waits for the window to arm. Signing what is not safe asks to say so
// first. The time left to sign shows above; once it is out, the transaction can only be
// rejected, or, one made in Otus, built again.
function Transaction({ t, answers, expiry, died }: { t: TransactionView; answers: Answers; expiry?: Expiry; died: boolean }) {
    const [step, setStep] = useState(0);
    const [reached, setReached] = useState(0);
    const go = (to: number) => (setStep(to), setReached((r) => Math.max(r, to)));
    const now = useNow(expiry ? 250 : null);
    const expired = died; // the network's word: a time left counted here may run out a little early

    const [ack, setAck] = useState(false);
    // Prepared while shown: the window arms again once the final form comes, which is what Sign answers.
    const armed = useArmed(t.preparing ? -1 - step : step);
    const risky = t.verdict === 'danger';
    const [onDevice, setOnDevice] = useState(false); // approved: a Ledger account signs on its device now
    // Read again at the click: the time may run out between two draws of the button.
    const allowed = () => armed && !t.preparing && t.signer !== 'none' && !t.blocked && !died && (!risky || ack);
    if (onDevice && t.ledger) return <OnLedger t={{ ...t, ledger: t.ledger }} answer={answers.answer} expiry={expiry} died={died} />;
    // The answers at the bottom: by step, and once the time to sign is out, building it again.
    const actions = () => {
        if (expired) {
            return (
                <>
                    <Answer onClick={() => answers.answer(false)}>Reject</Answer>
                    {expiry?.refresh && (
                        <Answer variant="default" onClick={expiry.refresh}>
                            Build it again
                        </Answer>
                    )}
                </>
            );
        }
        if (step < 2) {
            return (
                <>
                    {step === 0 ? <Answer onClick={() => answers.answer(false)}>Reject</Answer> : <Answer onClick={() => go(0)}>Back</Answer>}
                    <Answer variant="default" onClick={() => go(step + 1)}>
                        Next
                    </Answer>
                </>
            );
        }
        return (
            <>
                <Answer variant={risky ? 'default' : 'outline'} onClick={() => answers.answer(false)}>
                    Reject
                </Answer>
                <Answer variant={risky ? 'risky' : t.verdict === 'warn' ? 'warn' : 'default'} arms armed={armed} disabled={t.preparing || t.signer === 'none' || !!t.blocked || (risky && !ack)} onClick={() => allowed() && (t.ledger ? setOnDevice(true) : answers.answer(true))}>
                    {risky ? 'Sign anyway' : 'Sign'}
                </Answer>
            </>
        );
    };
    // Between the site and the account: the time left to sign, and the transaction to copy once prepared.
    const top = (expiry || t.wire) && (
        <span className="flex items-center gap-1.5">
            {expiry && <Left from={expiry.from} until={expiry.until} now={now} />}
            {t.wire && <CopyTransaction wire={t.wire} />}
        </span>
    );
    return (
        <Frame site={t.site} account={t.account} network={t.network} steps={<Steps at={step} reached={reached} go={go} />} chip={t.preparing ? undefined : t.chip} left={top} page={step} actions={actions()}>
            {expired && (
                <Notice>
                    Its <span className="font-bold text-warn">blockhash expired</span> before you signed it, so nothing was sent. {expiry?.refresh ? 'Building it again takes a fresh one.' : 'Ask the site for it again.'}
                </Notice>
            )}
            {t.blocked && <Notice>{t.blocked}</Notice>}
            {step === 0 && <Balances t={t} />}
            {step === 1 && <Programs t={t} />}
            {step === 2 && !t.preparing && <Verdict t={t} ack={ack} onAck={setAck} />}
        </Frame>
    );
}

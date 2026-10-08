// Taking access back, from Access: Otus builds the transaction (a delegate revoked, a nonce moved on) and the background
// reviews it as any site's, guards included; the review shows here with the time left to sign, then how it went.
// Leaving, or no, says no: nothing is sent.
import { getBase64Decoder, type Blockhash } from '@solana/kit';
import { useEffect, useRef, useState } from 'react';

import { cap, short } from '@otus-wallet/sdk/format';
import { fix, type Fix } from '../../send/fix.ts';
import { SIGN_WITHIN } from '../../send/lifetime.ts';
import type { Lifetime } from '../../send/transfer.ts';
import { explorerOf, type Settings } from '../../settings.ts';
import type { Account } from '../../shell/state.ts';
import { Icon } from '../components/icons.tsx';
import { Approve } from '../review/Approve.tsx';
import { Answer, Block, Frame, Heading, Left, Steps, useNow } from '../review/Frame.tsx';
import { filled, MARK } from '../review/tone.ts';
import type { AccountView, Approval, Life, SiteView, Tone } from '../view.ts';
import { said } from './store.ts';

const REVIEW_WAIT = 60_000; // ms for the review to come; each RPC request gives up sooner
const TAKING_BACK: SiteView = { origin: 'otus://popup', host: 'Otus', note: 'Taking access back', tone: 'plain' };
// No blockhash yet: the background reads one while it reviews it, and puts it in.
const UNSET: Lifetime = { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 0n };

type Reply = { ok: boolean; error?: string; result?: { signature?: unknown; outcome?: unknown } };
type Heard = { review: Approval } | { life: Life } | { done: Reply };

/** `what`: what is taken back, and `title` says it; `done` hears whether it landed, or that the user left. */
export function TakeBack({ account, what, title, settings, done }: { account: Account; what: Fix; title: string; settings: Settings; done: (landed: boolean) => void }) {
    const [approval, setApproval] = useState<Approval | null>(null);
    const [life, setLife] = useState<Life | undefined>();
    const [outcome, setOutcome] = useState<'sending' | Reply | null>(null);
    const [lifetime, setLifetime] = useState<{ from: number; until: number } | null>(null);
    const [attempt, setAttempt] = useState(0); // built again with a fresh blockhash
    const waiting = useRef<chrome.runtime.Port | null>(null); // the port of the review on show, until answered
    const sending = useRef<chrome.runtime.Port | null>(null); // the port of what is signed, until it lands or fails

    useEffect(() => {
        let live = true;
        setApproval(null);
        setLife(undefined);
        setOutcome(null);
        const from = Date.now(); // before the blockhash is read: the time to sign counted short, never long
        setLifetime({ from, until: from + SIGN_WITHIN });
        const stop = (why: string) => live && setOutcome({ ok: false, error: why });
        let bytes: Uint8Array;
        try {
            bytes = fix(account.address, what, UNSET);
        } catch (e) {
            stop(said(e));
            return;
        }
        const port = chrome.runtime.connect({ name: 'own' });
        waiting.current = port;
        const late = setTimeout(() => waiting.current === port && (port.disconnect(), stop('Otus did not answer in time: nothing was sent')), REVIEW_WAIT);
        port.onMessage.addListener((m: Heard) => {
            clearTimeout(late);
            if (!live) return;
            if ('review' in m) return setApproval(m.review);
            if ('life' in m) return setLife(m.life);
            port.disconnect();
            if (waiting.current === port) return stop(m.done.error ?? 'Otus could not send it'); // refused before any answer
            if (sending.current !== port) return;
            sending.current = null;
            setOutcome(m.done);
        });
        port.onDisconnect.addListener(() => {
            clearTimeout(late);
            if (waiting.current === port) return stop('Otus stopped before you answered: nothing was sent');
            if (sending.current === port) stop('Otus stopped while sending it: check Access again in a moment');
        });
        port.postMessage({ own: getBase64Decoder().decode(bytes), account: account.address, fix: true });
        return () => {
            live = false;
            clearTimeout(late);
            if (waiting.current === port) port.disconnect(); // leaving says no
        };
    }, [account.address, what, attempt]);

    const view: AccountView = { label: account.label, address: account.address };
    // No leaves; yes stays here while it goes, and says how it went.
    const answer = (yes: boolean, signature?: string) => {
        const port = waiting.current;
        waiting.current = null;
        if (!yes || !port) return void (port?.disconnect(), done(false));
        sending.current = port;
        try {
            port.postMessage({ approve: true, ...(signature && { signature }) });
        } catch {
            return setOutcome({ ok: false, error: 'Otus stopped before you answered: nothing was sent' });
        }
        setOutcome('sending');
    };
    if (outcome) return <Outcome account={view} title={title} outcome={outcome} done={done} again={() => setAttempt((n) => n + 1)} settings={settings} />;
    const expiry = lifetime ? { ...lifetime, refresh: () => setAttempt((n) => n + 1) } : undefined;
    if (!approval) return <Pending account={view} title={title} lifetime={lifetime} reject={() => answer(false)} />;
    return <Approve approval={approval} answers={{ answer }} expiry={expiry} life={life} />;
}

// What is taken back, above the review.
const Taken = ({ title }: { title: string }) => (
    <Block>
        <Heading>Taking back</Heading>
        <p className="text-xs font-bold">{title}</p>
    </Block>
);

// The review's frame at once, while the background simulates it: Next waits for it.
function Pending({ account, title, lifetime, reject }: { account: AccountView; title: string; lifetime: { from: number; until: number } | null; reject: () => void }) {
    const now = useNow(lifetime ? 250 : null);
    const actions = (
        <>
            <Answer onClick={reject}>Reject</Answer>
            <Answer variant="default" disabled onClick={() => {}}>
                Next
            </Answer>
        </>
    );
    return (
        <Frame site={TAKING_BACK} account={account} network={null} steps={<Steps at={0} />} left={lifetime && <Left from={lifetime.from} until={lifetime.until} now={now} />} actions={actions}>
            <Taken title={title} />
        </Frame>
    );
}

// Signed, in the same frame: on its way, then done, failed onchain, or not sent. One that did not go builds again with a
// fresh blockhash.
function Outcome({ account, title, outcome, done, again, settings }: { account: AccountView; title: string; outcome: 'sending' | Reply; done: (landed: boolean) => void; again: () => void; settings: Settings }) {
    const signature = outcome !== 'sending' && typeof outcome.result?.signature === 'string' ? outcome.result.signature : null;
    const [tone, heading, words] = told(outcome);
    const landed = outcome !== 'sending' && outcome.ok && outcome.result?.outcome === 'confirmed';
    const actions = () => {
        if (outcome === 'sending' || landed || (outcome.ok && outcome.result?.outcome === 'unknown')) {
            return (
                <Answer variant={outcome === 'sending' ? 'outline' : 'default'} onClick={() => done(landed)}>
                    {outcome === 'sending' ? 'Close' : 'Done'}
                </Answer>
            );
        }
        return (
            <>
                <Answer onClick={() => done(false)}>Back</Answer>
                <Answer variant="default" onClick={again}>
                    Try again
                </Answer>
            </>
        );
    };
    return (
        <Frame site={TAKING_BACK} account={account} network={null} actions={actions()}>
            <Taken title={title} />
            <div role="status" className={`outcome flex items-center gap-3 rounded-[3px] border p-3.5 ${tone === 'plain' ? 'border-rule text-ink' : `border-current ${filled(tone)}`}`}>
                <Icon name={outcome === 'sending' ? 'refresh' : MARK[tone]} size={28} stroke={2.5} />
                <div className="flex min-w-0 flex-col gap-1">
                    <p className="title pixel text-[22px] leading-[1.1]">{heading}</p>
                    <p className="font-bold">{words}</p>
                    {signature && (
                        <a href={explorerOf(settings).tx(signature)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-[3px] text-[11px] font-bold text-inherit">
                            {short(signature)}
                            <Icon name="external" size={11} stroke={2.5} />
                        </a>
                    )}
                </div>
            </div>
        </Frame>
    );
}

// What an outcome says: its tone, its title and its words.
function told(outcome: 'sending' | Reply): [Tone, string, string] {
    if (outcome === 'sending') return ['plain', 'Sending', 'Signed. The network confirms it in a few seconds.'];
    if (!outcome.ok) return ['danger', 'Not sent', cap(outcome.error ?? 'it failed')];
    if (outcome.result?.outcome === 'confirmed') return ['ok', 'Taken back', 'Confirmed by the network.'];
    if (outcome.result?.outcome === 'failed') return ['danger', 'Failed onchain', 'It landed and failed: only the fee was spent.'];
    return ['warn', 'Not confirmed yet', 'It may still land: check Access again in a moment.'];
}

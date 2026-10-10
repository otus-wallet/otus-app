// What Otus builds in the popup besides a transfer, reviewed as any site's transaction, guards included: taking access
// back from Access (a delegate revoked, a nonce moved on), native stake from Stake, or a swap from Swap. The review shows here with the
// time left to sign, then how it went. Leaving, or no, says no: nothing is sent.
import { getBase64Decoder, type Blockhash } from '@solana/kit';
import { useEffect, useMemo, useRef, useState } from 'react';

import { cap, short } from '@otus-wallet/sdk/format';
import { platform, type Port } from '@otus-wallet/core/platform.ts';
import { fix, type Fix } from '@otus-wallet/core/send/fix.ts';
import { SIGN_WITHIN } from '@otus-wallet/core/send/lifetime.ts';
import type { Lifetime } from '@otus-wallet/core/send/transfer.ts';
import { explorerOf, type Settings } from '@otus-wallet/core/settings.ts';
import type { Account } from '@otus-wallet/core/state.ts';
import { Icon } from '../components/icons.tsx';
import { Approve } from '../review/Approve.tsx';
import { Answer, Block, Frame, Heading, Left, Steps, useNow } from '../review/Frame.tsx';
import { filled, MARK } from '../review/tone.ts';
import type { AccountView, Approval, Life, SiteView, Tone } from '@otus-wallet/core/view.ts';
import { said } from './store.ts';

const REVIEW_WAIT = 60_000; // ms for the review to come; each RPC request gives up sooner
const TAKING_BACK: SiteView = { origin: 'otus://popup', host: 'Otus', note: 'Taking access back', tone: 'plain' };
const STAKING: SiteView = { origin: 'otus://popup', host: 'Otus', note: 'Your own stake', tone: 'plain' };
const SWAPPING: SiteView = { origin: 'otus://popup', host: 'Otus', note: 'Your own swap', tone: 'plain' };
// No blockhash yet: the background reads one while it reviews it, and puts it in.
const UNSET: Lifetime = { blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 0n };

type Reply = { ok: boolean; error?: string; result?: { signature?: unknown; outcome?: unknown } };
type Heard = { review: Approval } | { life: Life } | { done: Reply };

/** What Otus builds, as the background is told it (`fix`: taking access back; `stake`: native stake; `swap`: a swap,
 *  with what `asked` says the last one built was asked for); `make` builds it (again on a retry) for a lifetime;
 *  `doing` heads the screen ("Taking back"), `landed` titles it once confirmed ("Taken back"), and `where` is the screen
 *  to check again when that is not known yet. */
export type Job = { kind: 'fix' | 'stake' | 'swap'; make: (lifetime: Lifetime) => Uint8Array | Promise<Uint8Array>; doing: string; landed: string; where: string; asked?: () => object };

/** `what`: what is taken back, and `title` says it; `done` hears whether it landed, or that the user left. */
export function TakeBack({ account, what, title, settings, done }: { account: Account; what: Fix; title: string; settings: Settings; done: (landed: boolean) => void }) {
    const job = useMemo((): Job => ({ kind: 'fix', make: (lifetime) => fix(account.address, what, lifetime), doing: 'Taking back', landed: 'Taken back', where: 'Access' }), [account.address, what]);
    return <Doing account={account} job={job} title={title} settings={settings} done={done} />;
}

/** A job of Otus's own, reviewed, signed and sent here. `job` must stay the same object while it is on: a new one is
 *  built and reviewed anew. `done` hears whether it landed, and whether it may have gone out (on its way, or not
 *  confirmed yet): then it should not be made again at once. */
export function Doing({ account, job, title, settings, done }: { account: Account; job: Job; title: string; settings: Settings; done: (landed: boolean, gone?: boolean) => void }) {
    const [approval, setApproval] = useState<Approval | null>(null);
    const [life, setLife] = useState<Life | undefined>();
    const [outcome, setOutcome] = useState<'sending' | Reply | null>(null);
    const [lifetime, setLifetime] = useState<{ from: number; until: number } | null>(null);
    const [attempt, setAttempt] = useState(0); // built again with a fresh blockhash
    const waiting = useRef<Port | null>(null); // the port of the review on show, until answered
    const sending = useRef<Port | null>(null); // the port of what is signed, until it lands or fails

    useEffect(() => {
        let live = true;
        let port: Port | null = null;
        let late: ReturnType<typeof setTimeout> | undefined;
        setApproval(null);
        setLife(undefined);
        setOutcome(null);
        const from = Date.now(); // before the blockhash is read: the time to sign counted short, never long
        setLifetime({ from, until: from + SIGN_WITHIN });
        const stop = (why: string) => live && setOutcome({ ok: false, error: why });
        void (async () => {
            let bytes: Uint8Array;
            try {
                bytes = await job.make(UNSET);
            } catch (e) {
                return stop(said(e));
            }
            if (!live) return;
            let p: Port;
            try {
                p = platform.connect('own');
            } catch {
                return stop('Otus was reloaded: open it again'); // this page outlived the extension
            }
            port = p;
            waiting.current = p;
            late = setTimeout(() => waiting.current === p && (p.disconnect(), stop('Otus did not answer in time: nothing was sent')), REVIEW_WAIT);
            p.onMessage.addListener((m: Heard) => {
                clearTimeout(late);
                if (!live) return;
                if ('review' in m) return setApproval(m.review);
                if ('life' in m) return setLife(m.life);
                p.disconnect();
                if (waiting.current === p) return stop(m.done.error ?? 'Otus could not send it'); // refused before any answer
                if (sending.current !== p) return;
                sending.current = null;
                setOutcome(m.done);
            });
            p.onDisconnect.addListener(() => {
                clearTimeout(late);
                if (waiting.current === p) return stop('Otus stopped before you answered: nothing was sent');
                if (sending.current === p) stop(`Otus stopped while sending it: check ${job.where} again in a moment`);
            });
            try {
                // A swap tells what was asked for, which the background holds it to; the others, only their kind.
                p.postMessage({ own: getBase64Decoder().decode(bytes), account: account.address, [job.kind]: job.asked?.() ?? true });
            } catch {
                clearTimeout(late);
                stop('Otus was reloaded: open it again');
            }
        })();
        return () => {
            live = false;
            clearTimeout(late);
            if (port && waiting.current === port) port.disconnect(); // leaving says no
        };
    }, [account.address, job, attempt]);

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
    if (outcome) return <Outcome account={view} job={job} title={title} outcome={outcome} done={done} again={() => setAttempt((n) => n + 1)} settings={settings} />;
    const expiry = lifetime ? { ...lifetime, refresh: () => setAttempt((n) => n + 1) } : undefined;
    if (!approval) return <Pending account={view} job={job} title={title} lifetime={lifetime} reject={() => answer(false)} />;
    return <Approve approval={approval} answers={{ answer }} expiry={expiry} life={life} />;
}

// What is done, above the review.
const Taken = ({ job, title }: { job: Job; title: string }) => (
    <Block>
        <Heading>{job.doing}</Heading>
        <p className="text-sm font-bold">{title}</p>
    </Block>
);

const siteOf = (job: Job) => ({ fix: TAKING_BACK, stake: STAKING, swap: SWAPPING })[job.kind];

// The review's frame at once, while the background simulates it: Next waits for it.
function Pending({ account, job, title, lifetime, reject }: { account: AccountView; job: Job; title: string; lifetime: { from: number; until: number } | null; reject: () => void }) {
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
        <Frame site={siteOf(job)} account={account} network={null} steps={<Steps at={0} />} left={lifetime && <Left from={lifetime.from} until={lifetime.until} now={now} />} actions={actions}>
            <Taken job={job} title={title} />
        </Frame>
    );
}

// Signed, in the same frame: on its way, then done, failed onchain, or not sent. One that did not go builds again with a
// fresh blockhash.
function Outcome({ account, job, title, outcome, done, again, settings }: { account: AccountView; job: Job; title: string; outcome: 'sending' | Reply; done: (landed: boolean, gone?: boolean) => void; again: () => void; settings: Settings }) {
    const signature = outcome !== 'sending' && typeof outcome.result?.signature === 'string' ? outcome.result.signature : null;
    const [tone, heading, words] = told(outcome, job);
    const landed = outcome !== 'sending' && outcome.ok && outcome.result?.outcome === 'confirmed';
    const actions = () => {
        if (outcome === 'sending' || landed || (outcome.ok && outcome.result?.outcome === 'unknown')) {
            return (
                <Answer variant={outcome === 'sending' ? 'outline' : 'default'} onClick={() => done(landed, true)}>
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
        <Frame site={siteOf(job)} account={account} network={null} actions={actions()}>
            <Taken job={job} title={title} />
            <div role="status" className={`outcome flex items-center gap-3 rounded-[3px] border p-3.5 ${tone === 'plain' ? 'border-rule text-ink' : `border-current ${filled(tone)}`}`}>
                <Icon name={outcome === 'sending' ? 'refresh' : MARK[tone]} size={28} stroke={2.5} />
                <div className="flex min-w-0 flex-col gap-1">
                    <p className="title pixel text-3xl leading-[1.1]">{heading}</p>
                    <p className="font-bold">{words}</p>
                    {signature && (
                        <a href={explorerOf(settings).tx(signature)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-[3px] text-xs font-bold text-inherit">
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
function told(outcome: 'sending' | Reply, job: Job): [Tone, string, string] {
    if (outcome === 'sending') return ['plain', 'Sending', 'Signed. The network confirms it in a few seconds.'];
    if (!outcome.ok) return ['danger', 'Not sent', cap(outcome.error ?? 'it failed')];
    if (outcome.result?.outcome === 'confirmed') return ['ok', job.landed, 'Confirmed by the network.'];
    if (outcome.result?.outcome === 'failed') return ['danger', 'Failed onchain', 'It landed and failed: only the fee was spent.'];
    return ['warn', 'Not confirmed yet', `It may still land: check ${job.where} again in a moment.`];
}

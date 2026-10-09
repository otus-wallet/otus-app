// A site's transaction once approved, in its window: on its way, then how it ended, as the background tells it. It
// shows nothing secret, so Otus's lock does not cover it; closing the window changes nothing. Done opens Activity.
import { platform } from '../../platform.ts';
import { Icon } from '../components/icons.tsx';
import type { AccountView, Outcome, SiteView, Tone } from '../view.ts';
import { Answer, Frame } from './Frame.tsx';
import { filled, MARK } from './tone.ts';

export function Settled({ site, account, outcome }: { site: SiteView; account: AccountView; outcome: Outcome | null }) {
    const [tone, title, words] = told(outcome);
    const link = outcome && 'link' in outcome ? outcome.link : null;
    const going = !outcome || outcome.phase === 'sending' || outcome.phase === 'waiting';
    const heard = outcome !== null; // until the background's first word, only the yes was said
    return (
        <Frame site={site} account={account} network={null} actions={<Answer variant={going ? 'outline' : 'default'} onClick={going ? () => window.close() : activity}>{going ? 'Close' : 'Done'}</Answer>}>
            <div role="status" className={`outcome mt-3 flex items-center gap-3 rounded-[3px] border p-3.5 ${tone === 'plain' ? 'border-rule text-ink' : `border-current ${filled(tone)}`}`}>
                <Icon name={going ? 'refresh' : MARK[tone]} size={28} stroke={2.5} />
                <div className="flex min-w-0 flex-col gap-1">
                    <p className="title pixel text-[22px] leading-[1.1]">{title}</p>
                    <p className="font-bold">{words}</p>
                    {link && link.length > 0 && (
                        <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-[3px] text-[11px] font-bold text-inherit">
                            View in the explorer
                            <Icon name="external" size={11} stroke={2.5} />
                        </a>
                    )}
                </div>
            </div>
            {going && heard && <p className="text-[10.5px] text-ink-3">You can close this window: it changes nothing.</p>}
        </Frame>
    );
}

// Done: this window goes on to Activity, where the transaction now shows.
const activity = () => location.replace(platform.url('home.html#activity'));

// What an outcome says: its tone, its title and its words.
function told(outcome: Outcome | null): [Tone, string, string] {
    if (!outcome) return ['plain', 'Approved', 'Otus signs it now.'];
    if (outcome.phase === 'sending') return ['plain', 'Sending', 'Signed. The network confirms it in a few seconds.'];
    switch (outcome.phase) {
        case 'waiting':
            return ['plain', 'Signed', `${outcome.host} sends it now: Otus watches it land.`];
        case 'signed':
            return ['plain', 'Signed', `${outcome.host} sends it. Another account pays for it, so Otus can't follow it.`];
        case 'landed':
            return outcome.failed ? ['danger', 'Failed onchain', 'It landed and failed: only the fee was spent.'] : ['ok', 'Confirmed', 'Confirmed by the network.'];
        case 'unseen':
            return outcome.expired ? ['warn', 'Not landed', 'Its blockhash expired before it landed: it can no longer go through.'] : ['warn', 'Not confirmed yet', 'It may still land: check it before trying again.'];
        case 'refused':
            return ['danger', 'Not sent', outcome.error];
    }
}

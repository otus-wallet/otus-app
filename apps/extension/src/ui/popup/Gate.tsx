// What the popup shows before a wallet: nothing set up yet, or its background from another build. Otus locked is
// the shield's, over every page.
import { Initial } from '../components/shield.tsx';
import { Button } from '../components/ui/button.tsx';

export function Empty({ setUp }: { setUp: () => void }) {
    return (
        <main className="flex h-full flex-col p-6 text-center">
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
                <Initial />
                <h1 className="pixel text-base">Otus</h1>
                <p className="text-[10.5px] text-ink-2">Every transaction reviewed before you sign.</p>
            </div>
            <Button variant="default" className="w-full" onClick={setUp}>
                Set up Otus
            </Button>
        </main>
    );
}

// The popup is read from disk each time it opens; the background, only when Otus is (re)loaded. After an update in
// place, as a developer's rebuild, the two can differ: reloading brings them together, and locks Otus.
export function Stale() {
    return (
        <main className="flex h-full flex-col p-6 text-center">
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
                <Initial />
                <h1 className="pixel text-base">Otus was updated</h1>
                <p className="text-[10.5px] text-ink-2">Reload it to use the new version, then unlock it again.</p>
            </div>
            <Button variant="default" className="w-full" onClick={() => chrome.runtime.reload()}>
                Reload Otus
            </Button>
        </main>
    );
}

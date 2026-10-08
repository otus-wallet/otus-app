// Sites people sign on, to tell one that imitates them: a scam site often takes a known name with a word added or
// glued on, a letter changed or doubled, letters from another alphabet that look the same, or a free subdomain.
const KNOWN_SITES = [
    'jup.ag', 'raydium.io', 'orca.so', 'meteora.ag', 'pump.fun', 'magiceden.io', 'tensor.trade', 'marinade.finance',
    'kamino.finance', 'kamino.com', 'drift.trade', 'marginfi.com', 'sanctum.so', 'jito.network', 'solflare.com', 'phantom.app',
    'phantom.com', 'backpack.app', 'backpack.exchange', 'squads.so', 'solscan.io', 'solana.com', 'dexscreener.com', 'birdeye.so',
    'phoenix.trade', 'zeta.markets', 'parcl.co', 'exchange.art', 'tensor.so', 'sns.id', 'helius.dev',
];
const ALIASES: Record<string, string> = { pumpfun: 'pump.fun', jupiter: 'jup.ag' }; // names they also go by
// Brands unusual enough to count when found inside a longer name ("phantomwallet", "claimkamino").
const DISTINCT = new Set(['raydium', 'phantom', 'solflare', 'magiceden', 'meteora', 'marginfi', 'kamino', 'solscan', 'dexscreener', 'birdeye', 'helius']);
const ENDINGS = new Set(['jup', 'jito']); // short brands that count at the end of a name ("claimjup")
const WORDS = new Set(['exchange']); // brands that are plain words: only the site itself counts
// Where anyone can have a name: the label before one of these is the site's own. A short list of the public suffix
// list: country domains with a second level, and hosting that gives out free subdomains.
const SUFFIXES = [
    'co.uk', 'org.uk', 'me.uk', 'com.au', 'net.au', 'com.br', 'com.ar', 'com.mx', 'com.tr', 'com.cn', 'com.hk', 'com.sg', 'co.jp', 'co.kr', 'co.in', 'co.za', 'co.nz', 'co.id',
    'vercel.app', 'pages.dev', 'workers.dev', 'netlify.app', 'github.io', 'gitlab.io', 'web.app', 'firebaseapp.com', 'herokuapp.com', 'onrender.com', 'fly.dev', 'replit.app',
    'repl.co', 'glitch.me', 'surge.sh', 'gitbook.io', 'webflow.io', 'framer.app', 'framer.website', 'wixsite.com', 'blogspot.com', 'azurewebsites.net', 'amplifyapp.com',
    'cloudfront.net', 'ngrok.io', 'ngrok-free.app', 'ngrok.app', 'lovable.app', 'railway.app', 'up.railway.app', 'deno.dev', 'r2.dev', 'appspot.com', 'carrd.co', 'myshopify.com',
    'translate.goog', 'ipfs.dweb.link', 'on-fleek.app', 'vercel.dev', 'bolt.host', 'pinata.cloud', 'b-cdn.net',
];

/** The known site a host seems to imitate, or null when it is one, or resembles none. */
export function lookalike(host: string): string | null {
    const name = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\./, '');
    const under = (h: string, site: string) => h === site || h.endsWith(`.${site}`);
    if (KNOWN_SITES.some((s) => under(name, s))) return null;
    // Letters from other alphabets, or with marks, that read as a known site's: the browser shows them as written.
    const folded = name.split('.').map((label) => fold(punycode(label))).join('.');
    const copied = KNOWN_SITES.find((s) => under(folded, s));
    if (copied) return copied;
    const labels = folded.split('.');
    const suffix = SUFFIXES.find((s) => folded.endsWith(`.${s}`));
    const named = labels.slice(0, labels.length - (suffix ? suffix.split('.').length : 1)); // the site's name, and any subdomains
    for (const label of named) {
        const words = label.split(/[-_]+/).filter(Boolean);
        const joined = skeleton(words.join(''));
        for (const word of words) if (ALIASES[word]) return ALIASES[word];
        for (const [alias, site] of Object.entries(ALIASES)) if (joined.includes(skeleton(alias))) return site;
        for (const known of KNOWN_SITES) {
            const brand = known.split('.')[0];
            const mark = skeleton(brand);
            if (WORDS.has(brand)) {
                if (joined === mark) return known;
                continue;
            }
            const near = brand.length >= 9 ? 2 : brand.length >= 7 ? 1 : 0; // edits a longer name can take and still read the same
            if (words.some((w) => skeleton(w) === mark || (near > 0 && distance(skeleton(w), mark) <= near))) return known;
            if (DISTINCT.has(brand) && joined.includes(mark)) return known;
            if (ENDINGS.has(brand) && joined.length > mark.length && joined.endsWith(mark)) return known;
            if (near > 0 && distance(joined, mark) <= near) return known;
        }
    }
    return null;
}

// Letters that look like Latin ones, from Cyrillic, Greek and others, as Latin; marks dropped ("jüp" reads "jup").
const LOOKS: Record<string, string> = {
    а: 'a', ɑ: 'a', α: 'a', в: 'b', ь: 'b', с: 'c', ϲ: 'c', ԁ: 'd', е: 'e', ε: 'e', ҽ: 'e', ɡ: 'g', һ: 'h', і: 'i', ι: 'i', ј: 'j', к: 'k', κ: 'k', ӏ: 'l',
    м: 'm', ո: 'n', η: 'n', о: 'o', ο: 'o', ө: 'o', р: 'p', ρ: 'p', ԛ: 'q', г: 'r', ѕ: 's', т: 't', τ: 't', υ: 'u', ս: 'u', ν: 'v', ѵ: 'v', ԝ: 'w', ω: 'w',
    х: 'x', χ: 'x', у: 'y', γ: 'y', ʏ: 'y', ᴢ: 'z',
};
const fold = (s: string) => [...s.normalize('NFKD').replace(/\p{M}/gu, '')].map((c) => LOOKS[c] ?? c).join('');

/** A name as it reads: trimmed, its compatibility forms folded, lowercase, letters of other alphabets that look Latin
 *  as Latin ("USDС" with a Cyrillic С reads "usdc"). */
export const latin = (s: string) => fold(s.normalize('NFKC').trim().toLowerCase());

// What a name reads as at a glance: digits and letter pairs that pass for letters, as those letters.
const SAME: Record<string, string> = { 0: 'o', 1: 'l', i: 'l', '|': 'l', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g' };
const skeleton = (s: string) => s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[013-57-9i|]/g, (c) => SAME[c] ?? c);

// Edits between two words: letters added, removed or changed.
function distance(a: string, b: string): number {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) next.push(Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
        row = next;
    }
    return row[b.length];
}

// A label as the browser shows it: "xn--" names decoded (RFC 3492). One that does not decode stays as it is.
function punycode(label: string): string {
    if (!label.startsWith('xn--')) return label;
    const [BASE, T_MIN, T_MAX, SKEW, DAMP] = [36, 1, 26, 38, 700];
    const input = label.slice(4);
    const end = input.lastIndexOf('-');
    const output = end > 0 ? [...input.slice(0, end)] : [];
    const digit = (c: number) => (c >= 48 && c <= 57 ? c - 22 : c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 97 : BASE);
    const adapt = (delta: number, points: number, first: boolean) => {
        delta = first ? Math.floor(delta / DAMP) : delta >> 1;
        delta += Math.floor(delta / points);
        let k = 0;
        for (; delta > ((BASE - T_MIN) * T_MAX) >> 1; k += BASE) delta = Math.floor(delta / (BASE - T_MIN));
        return k + Math.floor(((BASE - T_MIN + 1) * delta) / (delta + SKEW));
    };
    let [n, i, bias, at] = [128, 0, 72, end > 0 ? end + 1 : 0];
    while (at < input.length) {
        const old = i;
        for (let w = 1, k = BASE; ; k += BASE) {
            if (at >= input.length) return label;
            const d = digit(input.charCodeAt(at++));
            if (d >= BASE) return label;
            i += d * w;
            const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
            if (d < t) break;
            w *= BASE - t;
            if (i > 0x10ffff * 64 || w > 0x10ffff * 64) return label;
        }
        bias = adapt(i - old, output.length + 1, old === 0);
        n += Math.floor(i / (output.length + 1));
        i %= output.length + 1;
        if (n > 0x10ffff) return label;
        output.splice(i++, 0, String.fromCodePoint(n));
    }
    return output.join('');
}

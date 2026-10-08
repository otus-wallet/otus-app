// Which build this code is from, set by build.mjs. Chrome reads an extension's pages from disk each time they open, but
// keeps running the background it started with until Otus is reloaded: the popup compares the two.
declare const __BUILD__: string | undefined;

export const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

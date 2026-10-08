import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/** A value compared with the copy kept in test/golden/<name>.json, written there the first time or when UPDATE_GOLDEN
 *  is set: for what a refactor must leave exactly as it was. */
export function golden(name: string, value: unknown) {
    const file = new URL(`./golden/${name}.json`, import.meta.url);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN || !existsSync(file)) {
        mkdirSync(new URL('./golden/', import.meta.url), { recursive: true });
        writeFileSync(file, text);
        return;
    }
    assert.equal(text, readFileSync(file, 'utf8'), `${name} changed: if on purpose, run with UPDATE_GOLDEN=1`);
}

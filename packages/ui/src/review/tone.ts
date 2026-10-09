// The colours a tone gives a line, a box or a mark in the review: a level, or plain text.
import type { Tone } from '@otus-wallet/core/view.ts';

/** The mark for each tone: a check when fine, a bar for something to know or check, a cross for danger. */
export const MARK = { ok: 'check', notice: 'bang', warn: 'bang', danger: 'cross', plain: 'check' } as const;

/** Text in the tone's colour; plain stays as it is. */
export const text = (tone: Tone) => ({ ok: 'text-ok', notice: 'text-warn', warn: 'text-warn', danger: 'text-danger', plain: '' })[tone];

/** A box filled in the tone: its colour, its background, and its border in the same colour. */
export const filled = (tone: Tone) => ({ ok: 'text-ok bg-ok-bg', notice: 'text-warn bg-warn-bg', warn: 'text-warn bg-warn-bg', danger: 'text-danger bg-danger-bg', plain: 'text-ok bg-ok-bg' })[tone];

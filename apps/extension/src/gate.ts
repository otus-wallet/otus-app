import type { Request } from '@otus-wallet/core/intake.ts';
import { Refused } from '@otus-wallet/core/protocol.ts';
import type { Settings } from '@otus-wallet/core/settings.ts';

/** Request → the same Request if the user's settings allow it. Throws Refused. */
export function gate(request: Request, settings: Settings): Request {
    if (request.kind === 'transaction' && request.transactions.length > 1 && !settings.signAll) {
        throw new Refused('signing several transactions at once is off in settings');
    }
    return request;
}

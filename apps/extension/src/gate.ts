import type { Request } from '@otus-wallet/core/intake.ts';
import { MAX_BATCH, Refused } from '@otus-wallet/core/protocol.ts';

/** Request → the same Request, when Otus takes that much in one: at most MAX_BATCH transactions signed together.
 *  Throws Refused. */
export function gate(request: Request): Request {
    if (request.kind === 'transaction' && request.transactions.length > MAX_BATCH) throw new Refused(`Otus signs at most ${MAX_BATCH} transactions in one request`);
    return request;
}

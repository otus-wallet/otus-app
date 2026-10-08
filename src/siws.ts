// Sign In With Solana: the fields in the order its message writes them, under the words it writes them with; the
// approval shows them the same way.
import { SIGN_IN_FIELDS, type SignInField, type SignInInput } from './protocol.ts';

const LABELS: Record<SignInField, string> = {
    domain: 'Domain',
    address: 'Address',
    statement: 'Statement',
    uri: 'URI',
    version: 'Version',
    chainId: 'Chain ID',
    nonce: 'Nonce',
    issuedAt: 'Issued At',
    expirationTime: 'Expiration Time',
    notBefore: 'Not Before',
    requestId: 'Request ID',
};

/** The fields a sign-in sets, as the approval lists them. */
export function signInFields(i: SignInInput): [string, string][] {
    const fields = SIGN_IN_FIELDS.flatMap((k): [string, string][] => (i[k] ? [[LABELS[k], i[k]]] : []));
    return i.resources?.length ? [...fields, ['Resources', i.resources.join('\n')]] : fields;
}

/** The message signed, written as the reference implementation writes it, so the site can check it. */
export function signInText(i: SignInInput & { domain: string; address: string }): string {
    const lines = SIGN_IN_FIELDS.slice(3).flatMap((k) => (i[k] ? [`${LABELS[k]}: ${i[k]}`] : [])); // after domain, address, statement
    if (i.resources) lines.push('Resources:', ...i.resources.map((r) => `- ${r}`));
    return `${i.domain} wants you to sign in with your Solana account:\n${i.address}${i.statement ? `\n\n${i.statement}` : ''}${lines.length ? `\n\n${lines.join('\n')}` : ''}`;
}

// Runs in the site's page. It shows Otus to the site as a Wallet Standard wallet and hands every call to the
// content script; it holds no key and decides nothing.
import { getAddressEncoder, getBase58Encoder, getBase64Decoder, getBase64Encoder, type Address } from '@solana/kit';
import {
    SolanaSignAndSendTransaction,
    SolanaSignIn,
    SolanaSignMessage,
    SolanaSignTransaction,
    type SolanaSignAndSendTransactionFeature,
    type SolanaSignInFeature,
    type SolanaSignInInput,
    type SolanaSignMessageFeature,
    type SolanaSignTransactionFeature,
    type SolanaSignTransactionInput,
} from '@solana/wallet-standard-features';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
    StandardConnect,
    StandardDisconnect,
    StandardEvents,
    type StandardConnectFeature,
    type StandardDisconnectFeature,
    type StandardEventsFeature,
    type StandardEventsListeners,
} from '@wallet-standard/features';
import { registerWallet } from '@wallet-standard/wallet';

import { CHAINS } from '../intake.ts';
import { CHANNEL, type Call, type PageMessage, type Reply } from '../protocol.ts';

// Otus's mark, as sites list it: the toolbar icon's pixel O, green on black.
const ICON = `data:image/svg+xml;base64,${btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16"/>' +
        '<path fill="#3DF2A6" d="M5 3h6v2H5zM5 11h6v2H5zM3 5h2v6H3zM11 5h2v6h-2z"/></svg>',
)}` as const;
const VERSIONS = ['legacy', 0, 1] as const;
const WITHOUT_V1 = ['legacy', 0] as const; // for an account on a Ledger, whose Solana app cannot read v1
const ACCOUNT_FEATURES = [SolanaSignTransaction, SolanaSignAndSendTransaction, SolanaSignMessage, SolanaSignIn] as const;

const base64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);
const bytes = (base64: string) => new Uint8Array(getBase64Encoder().encode(base64));

let next = 0;
const waiting = new Map<number, (reply: Reply) => void>();

/** One call to the background, through the content script. A refusal by the user carries code 4001, as wallets do. */
function call<T>(c: Call): Promise<T> {
    const id = ++next;
    return new Promise((resolve, reject) => {
        waiting.set(id, (reply) => (reply.ok ? resolve(reply.result as T) : reject(Object.assign(new Error(reply.error), reply.rejected ? { code: 4001 } : {}))));
        window.postMessage({ channel: CHANNEL, kind: 'request', id, call: c } satisfies PageMessage, window.location.origin);
    });
}

class Otus implements Wallet {
    readonly version = '1.0.0' as const;
    readonly name = 'Otus';
    readonly icon = ICON;
    readonly chains = CHAINS;
    #accounts: WalletAccount[] = [];
    #v1 = true; // whether the account the site sees can sign v1
    #listeners: StandardEventsListeners['change'][] = [];

    get accounts() {
        return this.#accounts.slice();
    }

    get features(): StandardConnectFeature &
        StandardDisconnectFeature &
        StandardEventsFeature &
        SolanaSignTransactionFeature &
        SolanaSignAndSendTransactionFeature &
        SolanaSignMessageFeature &
        SolanaSignInFeature {
        return {
            [StandardConnect]: { version: '1.0.0', connect: this.#connect },
            [StandardDisconnect]: { version: '1.0.0', disconnect: this.#disconnect },
            [StandardEvents]: { version: '1.0.0', on: this.#on },
            [SolanaSignTransaction]: { version: '1.0.0', supportedTransactionVersions: this.#v1 ? VERSIONS : WITHOUT_V1, signTransaction: this.#signTransaction },
            [SolanaSignAndSendTransaction]: { version: '1.0.0', supportedTransactionVersions: this.#v1 ? VERSIONS : WITHOUT_V1, signAndSendTransaction: this.#signAndSend },
            [SolanaSignMessage]: { version: '1.1.0', signMessage: this.#signMessage },
            [SolanaSignIn]: { version: '1.0.0', signIn: this.#signIn },
        };
    }

    /** The site's accounts as Otus has them now, the same objects while they stay the same; and whether they can sign
     *  v1, which changes the transaction versions the site is told Otus takes. */
    show(addresses: string[], v1 = true) {
        const versions = v1 !== this.#v1;
        this.#v1 = v1;
        if (versions) for (const listener of this.#listeners) listener({ features: this.features });
        if (addresses.join() === this.#accounts.map((a) => a.address).join()) return;
        this.#accounts = addresses.map((address) =>
            Object.freeze({ address, publicKey: new Uint8Array(getAddressEncoder().encode(address as Address)), chains: CHAINS, features: ACCOUNT_FEATURES }),
        );
        for (const listener of this.#listeners) listener({ accounts: this.accounts });
    }

    #connect: StandardConnectFeature[typeof StandardConnect]['connect'] = async (input) => {
        const { accounts, v1 } = await call<{ accounts: string[]; v1?: boolean }>({ method: 'connect', params: { silent: input?.silent === true } });
        this.show(accounts, v1 !== false);
        return { accounts: this.accounts };
    };

    #disconnect = async () => {
        await call({ method: 'disconnect' });
        this.show([]);
    };

    #on: StandardEventsFeature[typeof StandardEvents]['on'] = (event, listener) => {
        if (event !== 'change') return () => {};
        this.#listeners.push(listener);
        return () => (this.#listeners = this.#listeners.filter((l) => l !== listener));
    };

    #signTransaction: SolanaSignTransactionFeature[typeof SolanaSignTransaction]['signTransaction'] = async (...inputs) => {
        const { transactions } = await call<{ transactions: string[] }>({ method: 'signTransaction', params: transactionsOf(inputs) });
        return transactions.map((t) => ({ signedTransaction: bytes(t) }));
    };

    #signAndSend: SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction]['signAndSendTransaction'] = async (...inputs) => {
        const { signatures } = await call<{ signatures: string[] }>({ method: 'signAndSendTransaction', params: transactionsOf(inputs) });
        return signatures.map((s) => ({ signature: new Uint8Array(getBase58Encoder().encode(s)) }));
    };

    #signMessage: SolanaSignMessageFeature[typeof SolanaSignMessage]['signMessage'] = async (...inputs) => {
        const outputs = [];
        for (const { account, message } of inputs) {
            const r = await call<{ signedMessage: string; signature: string }>({ method: 'signMessage', params: { account: account.address, message: base64(message) } });
            outputs.push({ signedMessage: bytes(r.signedMessage), signature: bytes(r.signature), signatureType: 'ed25519' as const });
        }
        return outputs;
    };

    #signIn: SolanaSignInFeature[typeof SolanaSignIn]['signIn'] = async (...inputs) => {
        const outputs = [];
        for (const input of inputs) {
            const r = await call<{ account: string; signedMessage: string; signature: string }>({ method: 'signIn', params: signInOf(input) });
            this.show([r.account]); // signing in connects the site to that account
            outputs.push({ account: this.#accounts[0], signedMessage: bytes(r.signedMessage), signature: bytes(r.signature), signatureType: 'ed25519' as const });
        }
        return outputs;
    };
}

// One call signs for one account on one chain, as the review shows one wallet's changes.
function transactionsOf(inputs: readonly SolanaSignTransactionInput[]) {
    const [first] = inputs;
    if (!first || inputs.some((i) => i.account.address !== first.account.address || i.chain !== first.chain)) {
        throw new Error('Otus signs for one account on one chain per call');
    }
    return { account: first.account.address, chain: first.chain, transactions: inputs.map((i) => base64(i.transaction)) };
}

// Only the text fields of Sign In With Solana; the background checks them.
function signInOf(input: SolanaSignInInput) {
    const { useOffchainMessage: _, resources, ...fields } = input;
    return { ...fields, ...(resources && { resources: [...resources] }) };
}

const wallet = new Otus();
window.addEventListener('message', (event: MessageEvent<PageMessage>) => {
    if (event.source !== window || event.data?.channel !== CHANNEL) return;
    const m = event.data;
    if (m.kind === 'response') {
        waiting.get(m.id)?.(m.reply);
        waiting.delete(m.id);
    } else if (m.kind === 'accounts') {
        wallet.show(m.accounts, m.v1 !== false);
    }
});
registerWallet(wallet);

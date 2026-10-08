import type { Cluster } from './intake.ts';

/** The network the wallet shows: Solana's mainnet (through Otus's relay), devnet, or an endpoint of your own, whose
 *  network Otus asked it when you saved it. */
export type Network = 'mainnet' | 'devnet' | 'custom';

/** What the user can change. Every default is the cautious choice. */
export type Settings = {
    signAll: boolean; // let a site ask for several transactions in one call
    network: Network;
    rpc: string | null; // your own endpoint, used while the network is 'custom'
    custom: Cluster | null; // the network that endpoint serves, by the genesis hash it gave
    lockAfter: number; // minutes Otus stays unlocked once closed; 0 locks it as it closes
    explorer: Explorer; // where a transaction opens
    preflight: boolean; // the RPC simulates a transaction as it is sent, and refuses one that would fail
};

export const DEFAULT_SETTINGS: Settings = { signAll: false, network: 'mainnet', rpc: null, custom: null, lockAfter: 15, explorer: 'solscan', preflight: true };

/** Settings as stored → as used, defaults for what is missing. Saved before networks, an endpoint of your own was
 *  mainnet's. */
export function settingsOf(stored: Partial<Settings> | undefined): Settings {
    const settings = { ...DEFAULT_SETTINGS, ...stored };
    if (stored?.network === undefined && stored?.rpc) return { ...settings, network: 'custom', custom: 'solana:mainnet' };
    return settings;
}

/** The network the wallet shows: mainnet until an endpoint of your own says it serves another. */
export function networkOf(settings: Settings): Cluster {
    if (settings.network === 'devnet') return 'solana:devnet';
    if (settings.network === 'custom' && settings.rpc && settings.custom) return settings.custom;
    return 'solana:mainnet';
}

// The genesis hash each public network gives; any other is a validator of your own, as a local one.
const GENESIS: Record<string, Cluster> = {
    '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'solana:mainnet',
    EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: 'solana:devnet',
    '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'solana:testnet',
};

/** The network an endpoint serves, by the genesis hash it gives. */
export const clusterOfGenesis = (hash: string): Cluster => (Object.hasOwn(GENESIS, hash) ? GENESIS[hash] : 'solana:localnet');

/** A network's name, as the wallet shows it. */
export const networkName = (cluster: Cluster) => ({ 'solana:mainnet': 'Mainnet', 'solana:devnet': 'Devnet', 'solana:testnet': 'Testnet', 'solana:localnet': 'Localnet' })[cluster];

/** The explorers a transaction can open in, by name, and the page each gives one on mainnet. */
export const EXPLORERS = {
    solscan: { name: 'Solscan', tx: (signature: string) => `https://solscan.io/tx/${signature}` },
    solana: { name: 'Solana Explorer', tx: (signature: string) => `https://explorer.solana.com/tx/${signature}` },
    orb: { name: 'Orb', tx: (signature: string) => `https://orbmarkets.io/tx/${signature}` },
} as const;
export type Explorer = keyof typeof EXPLORERS;

/** The explorer chosen (the default when what is stored is not one), its pages on the network the wallet shows: a
 *  local one by its endpoint. */
export function explorerOf(settings: Settings) {
    const chosen = EXPLORERS[Object.hasOwn(EXPLORERS, settings.explorer) ? settings.explorer : DEFAULT_SETTINGS.explorer];
    const cluster = networkOf(settings);
    const on = cluster === 'solana:mainnet' ? '' : cluster === 'solana:localnet' ? `?cluster=custom&customUrl=${encodeURIComponent(settings.rpc ?? '')}` : `?cluster=${cluster.slice('solana:'.length)}`;
    return { name: chosen.name, tx: (signature: string) => `${chosen.tx(signature)}${on}` };
}

export const LOCK_CHOICES = [0, 1, 2, 5, 15, 30, 60];
export const MAX_LOCK_AFTER = 1440; // a day

/** A lock time as stored → minutes, or the default when it is not a whole number in range. */
export const lockMinutes = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_LOCK_AFTER ? (v as number) : DEFAULT_SETTINGS.lockAfter);

// Otus's RPC: otus-server's proxy, which holds the provider's key (never in the extension) and lets through only
// Otus Wallet's origin and the methods it calls.
export const OTUS_RPC = 'https://otus-server-production.up.railway.app';

const PUBLIC_RPC: Record<Cluster, string> = {
    'solana:mainnet': OTUS_RPC,
    'solana:devnet': 'https://api.devnet.solana.com',
    'solana:testnet': 'https://api.testnet.solana.com',
    'solana:localnet': 'http://127.0.0.1:8899',
};

/** The endpoint for a cluster: your own while the network is yours and it serves that cluster; else the public one. */
export const rpcFor = (cluster: Cluster, settings: Settings) => (settings.network === 'custom' && settings.rpc && settings.custom === cluster ? settings.rpc : PUBLIC_RPC[cluster]);

/** The endpoint of the network the wallet shows. */
export const walletRpc = (settings: Settings) => rpcFor(networkOf(settings), settings);

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clusterOfGenesis, DEFAULT_SETTINGS, explorerOf, networkOf, OTUS_RPC, rpcFor, settingsOf, walletRpc, type Settings } from '../src/settings.ts';

const SIGNATURE = '5WX9C5kCQNULGGrSHJBR1WDFyetVyekbUpe1KQ45p3zEBe6jVgSsJuMqLWijjTDcnaAK2518ZriktRMCNycnsNAG';

test('a transaction opens in the explorer chosen; Solscan when none is, or what is stored is not one', () => {
    const at = (explorer: unknown) => explorerOf({ ...DEFAULT_SETTINGS, explorer } as Settings).tx(SIGNATURE);
    assert.equal(at('solscan'), `https://solscan.io/tx/${SIGNATURE}`);
    assert.equal(at('solana'), `https://explorer.solana.com/tx/${SIGNATURE}`);
    assert.equal(at('orb'), `https://orbmarkets.io/tx/${SIGNATURE}`);
    for (const stored of [undefined, 'etherscan', 'toString', '__proto__', 7]) assert.equal(at(stored), `https://solscan.io/tx/${SIGNATURE}`);
});

const MINE = 'https://devnet.helius-rpc.com/?api-key=secret';

test('the network the wallet shows, and the endpoint of each cluster', () => {
    assert.equal(networkOf(DEFAULT_SETTINGS), 'solana:mainnet');
    assert.equal(walletRpc(DEFAULT_SETTINGS), OTUS_RPC);
    const devnet: Settings = { ...DEFAULT_SETTINGS, network: 'devnet' };
    assert.equal(networkOf(devnet), 'solana:devnet');
    assert.equal(walletRpc(devnet), 'https://api.devnet.solana.com');
    // Your own endpoint serves its own network, and only while Custom is chosen.
    const custom: Settings = { ...DEFAULT_SETTINGS, network: 'custom', rpc: MINE, custom: 'solana:devnet' };
    assert.equal(networkOf(custom), 'solana:devnet');
    assert.equal(walletRpc(custom), MINE);
    assert.equal(rpcFor('solana:mainnet', custom), OTUS_RPC); // a site's mainnet transaction, reviewed on mainnet
    assert.equal(walletRpc({ ...custom, network: 'mainnet' }), OTUS_RPC);
    assert.equal(networkOf({ ...custom, rpc: null }), 'solana:mainnet'); // nothing saved: mainnet
});

test('settings saved before networks: an endpoint of your own was mainnet\'s', () => {
    assert.deepEqual(settingsOf({ rpc: 'https://mine.example' } as Partial<Settings>), { ...DEFAULT_SETTINGS, network: 'custom', rpc: 'https://mine.example', custom: 'solana:mainnet' });
    assert.deepEqual(settingsOf(undefined), DEFAULT_SETTINGS);
    assert.equal(settingsOf({ network: 'devnet', rpc: 'https://mine.example' }).network, 'devnet');
});

test('an endpoint\'s network, by the genesis hash it gives; explorer pages on that network', () => {
    assert.equal(clusterOfGenesis('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'), 'solana:mainnet');
    assert.equal(clusterOfGenesis('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'), 'solana:devnet');
    assert.equal(clusterOfGenesis('4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'), 'solana:testnet');
    assert.equal(clusterOfGenesis('anything else'), 'solana:localnet');
    assert.equal(clusterOfGenesis('toString'), 'solana:localnet');
    assert.equal(explorerOf({ ...DEFAULT_SETTINGS, network: 'devnet' }).tx(SIGNATURE), `https://solscan.io/tx/${SIGNATURE}?cluster=devnet`);
    const local: Settings = { ...DEFAULT_SETTINGS, network: 'custom', rpc: 'http://127.0.0.1:8899', custom: 'solana:localnet', explorer: 'solana' };
    assert.equal(explorerOf(local).tx(SIGNATURE), `https://explorer.solana.com/tx/${SIGNATURE}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899`);
    // A token's page, on the network the wallet shows.
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    assert.equal(explorerOf(DEFAULT_SETTINGS).token(USDC), `https://solscan.io/token/${USDC}`);
    assert.equal(explorerOf({ ...DEFAULT_SETTINGS, explorer: 'orb', network: 'devnet' }).token(USDC), `https://orbmarkets.io/address/${USDC}?cluster=devnet`);
});

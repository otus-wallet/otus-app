// Programs Otus knows: widely used, each checked to be a program on mainnet (and, where it publishes an IDL, by the
// name it gives itself there); those that keep something of yours where no balance shows it; and the names a program
// Otus doesn't know may borrow to pass for one it does.
import { address, type Address } from '@solana/kit';

import { LIGHTHOUSE } from './addresses.ts';
import { CORE_PLUGINS } from './core.ts';

export { LIGHTHOUSE };

const NAMES: [string, string][] = [
    ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'Jupiter v6'],
    ['61DFfeTKM7trxYcPQCM78bJ794ddZprZpAwAnLiwTpYH', 'Jupiter Order Engine'], // order_engine: its RFQ fills
    ['DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M', 'Jupiter DCA'],
    ['j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X', 'Jupiter Limit Order'],
    ['PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu', 'Jupiter Perpetuals'],
    ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'Raydium AMM'],
    ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'Raydium CLMM'],
    ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', 'Raydium CPMM'],
    ['LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', 'Raydium LaunchLab'],
    ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 'Orca Whirlpool'],
    ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'Meteora DLMM'],
    ['Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', 'Meteora Pools'],
    ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', 'Meteora DAMM v2'],
    ['dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', 'Meteora Bonding Curve'],
    ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'Pump.fun'],
    ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'PumpSwap'],
    ['PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY', 'Phoenix'],
    ['opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb', 'OpenBook v2'],
    ['MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD', 'Marinade'],
    ['SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy', 'Stake Pool'],
    ['SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY', 'Sanctum Single Validator'],
    ['SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn', 'Sanctum Multi Validator'],
    ['5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx', 'Sanctum Infinity'], // the S Controller, per Sanctum's deployed programs
    ['Stake11111111111111111111111111111111111111', 'Stake Program'],
    ['KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', 'Kamino Lend'],
    ['dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH', 'Drift'],
    ['MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA', 'MarginFi'],
    ['SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf', 'Squads v4'],
    ['metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', 'Metaplex Token Metadata'],
    ['BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY', 'Metaplex Bubblegum'],
    ['CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', 'Metaplex Core'],
    ['TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN', 'Tensor Swap'],
    ['TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp', 'Tensor Marketplace'],
    ['M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K', 'Magic Eden'],
    ['T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt', 'Jito Tip Payment'],
    ['L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95', 'Lighthouse'],
    ['AddressLookupTab1e1111111111111111111111111', 'Address Lookup Table'],
    ['BPFLoaderUpgradeab1e11111111111111111111111', 'Upgradeable Loader'],
    // Checked on mainnet, with the name each one's IDL gives where it has one.
    ['So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo', 'Solend'],
    ['4MangoMjqJ2firMokCjjGgoK8d4MXcrgL7XJaL3w6fVg', 'Mango v4'], // mango_v4
    ['SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu', 'Squads v3'], // squads_mpl
    ['GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw', 'SPL Governance'],
    ['MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG', 'Moonshot'], // token_launchpad
    ['2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c', 'Lifinity v2'], // lifinity_amm_v2
    ['9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', 'Orca Token Swap'],
    ['srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX', 'OpenBook v1'],
    ['SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ', 'Saber'],
    ['mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc', 'Magic Eden MMM'], // mmm
    ['CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR', 'Metaplex Candy Machine'], // candy_machine_core
    ['Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g', 'Metaplex Candy Guard'], // candy_guard
    ['auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg', 'Metaplex Token Auth Rules'],
    ['noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV', 'SPL Noop'],
    ['cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK', 'SPL Account Compression'], // spl_account_compression
    ['rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ', 'Pyth Receiver'], // pyth_solana_receiver
    ['pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT', 'Pyth Push Oracle'], // pyth_push_oracle
    ['worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth', 'Wormhole'],
    ['wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb', 'Wormhole Token Bridge'],
    ['src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4', 'deBridge Source'],
    ['dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo', 'deBridge Destination'],
    ['GovaE4iu227srtG2s3tZzB4RmWBzw8sTwrCLZz7kN7rY', 'Jupiter Governance'], // govern
    ['voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj', 'Jupiter Locked Voter'], // locked_voter
    ['vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR', 'Drift Vaults'], // drift_vaults
    ['ZETAxsqBRek56DhiGXrn75yj2NHU3aYUnxvHXpkf3aD', 'Zeta'], // zeta
    ['Vote111111111111111111111111111111111111111', 'Vote Program'],
    ['4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7', 'Jito Tip Distribution'], // jito_tip_distribution
    ['24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi', 'Meteora Vault'], // vault
    ['FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr', 'Kamino Farms'], // farms
    ['kvauTFR8qm1dhniz6pYuBZkuene3Hfrs1VQhVRgCNrr', 'Kamino Vaults'], // kamino_vault, until March 2026
    ['KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd', 'Kamino Vaults'], // kaminoVault: Kamino Earn, in use
    ['stkitrT1Uoy18Dk1fTrgPw8W6MVzoCfYoAFT4MLsmhq', 'Sanctum Stake Router'],
    ['6m2CDdhRgxpH4WjvdzxAYbGxwdGUz5MziiL5jek2kBma', 'OKX DEX Router'], // dex_solana
    ['DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH', 'DFlow'], // swap_orchestrator
    ['boop8hVGQGqehUK2iVEMEnMrL5RbjywRzHKBmBE7ry4', 'Boop'], // boop
    ['pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', 'Pump Fees'], // pump_fees
];


/**
 * Known programs that keep something of yours in their own accounts, where no balance of yours shows it: loans and
 * collateral, stakes, orders, votes, memberships, compressed and core NFTs. A program Otus doesn't know that takes
 * your signature into one of these could act for you there. Swaps are not among them: what a swap moves is in your
 * token accounts, which guards hold.
 */
export const HOLDS: ReadonlySet<Address> = new Set(
    [
        'Stake11111111111111111111111111111111111111',
        'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD',
        'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy',
        'SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY',
        'SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn',
        '5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx',
        'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD',
        'FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr',
        'kvauTFR8qm1dhniz6pYuBZkuene3Hfrs1VQhVRgCNrr',
        'KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd',
        'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH',
        'vAuLTsyrvSfZRuRB3XgvkPwNGgYSs9YRYymVebLKoxR',
        'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA',
        'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo',
        '4MangoMjqJ2firMokCjjGgoK8d4MXcrgL7XJaL3w6fVg',
        'ZETAxsqBRek56DhiGXrn75yj2NHU3aYUnxvHXpkf3aD',
        'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu',
        'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M',
        'j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X',
        'GovaE4iu227srtG2s3tZzB4RmWBzw8sTwrCLZz7kN7rY',
        'voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj',
        'GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw',
        'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',
        'SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu',
        'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY',
        'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
        '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi',
    ].map((a) => address(a)),
);

/** What a program Otus doesn't know may call itself to pass for one it does: the brands of the programs above. */
export const BRANDS: readonly string[] = ['jupiter', 'raydium', 'orca', 'whirlpool', 'meteora', 'pumpfun', 'pumpswap', 'phoenix', 'openbook', 'marinade', 'sanctum', 'kamino', 'drift', 'marginfi', 'solend', 'mango', 'squads', 'metaplex', 'bubblegum', 'tensor', 'magiceden', 'jito', 'lighthouse', 'wormhole', 'pyth', 'debridge', 'lifinity', 'moonshot', 'saber', 'dflow', 'okx'];

/** Every program Otus can name: those it reads, and the well-known ones above. */
export const PROGRAM_NAMES: ReadonlyMap<Address, string> = new Map<Address, string>([
    ...NAMES.map(([a, name]) => [address(a), name] as [Address, string]),
    ...CORE_PLUGINS.map((p) => [p.program, p.name] as [Address, string]),
]);

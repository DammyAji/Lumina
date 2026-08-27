/**
 * Networks Lumina can settle an atomic swap across.
 *
 * `STELLAR` is always the target chain — it is where merchants are paid in
 * USDC. Every other chain can only appear as the source of a swap.
 */
export enum SwapChain {
  ETHEREUM = 'ethereum',
  POLYGON = 'polygon',
  BITCOIN = 'bitcoin',
  SOLANA = 'solana',
  STELLAR = 'stellar',
}

/**
 * How a chain expresses its timelock. HTLCs on UTXO and account chains measure
 * timeouts in block/ledger height; EVM and Solana HTLCs use wall-clock seconds.
 */
export enum TimeoutUnit {
  BLOCK_HEIGHT = 'block_height',
  UNIX_SECONDS = 'unix_seconds',
}

export interface ChainMetadata {
  chain: SwapChain;
  displayName: string;
  nativeAsset: string;
  /** Decimals of the chain's smallest unit, used to normalise swap amounts. */
  decimals: number;
  timeoutUnit: TimeoutUnit;
  /** Rough seconds between blocks, used to convert a timeout into a deadline. */
  averageBlockTimeSeconds: number;
  /** Confirmations before a lock is treated as final, sized against reorg depth. */
  requiredConfirmations: number;
  canBeSource: boolean;
  canBeTarget: boolean;
}

export const CHAIN_METADATA: Readonly<Record<SwapChain, ChainMetadata>> = Object.freeze({
  [SwapChain.ETHEREUM]: {
    chain: SwapChain.ETHEREUM,
    displayName: 'Ethereum',
    nativeAsset: 'ETH',
    decimals: 18,
    timeoutUnit: TimeoutUnit.UNIX_SECONDS,
    averageBlockTimeSeconds: 12,
    requiredConfirmations: 12,
    canBeSource: true,
    canBeTarget: false,
  },
  [SwapChain.POLYGON]: {
    chain: SwapChain.POLYGON,
    displayName: 'Polygon',
    nativeAsset: 'MATIC',
    decimals: 18,
    timeoutUnit: TimeoutUnit.UNIX_SECONDS,
    averageBlockTimeSeconds: 2,
    // Polygon reorgs are both deeper and cheaper to cause than Ethereum's.
    requiredConfirmations: 128,
    canBeSource: true,
    canBeTarget: false,
  },
  [SwapChain.BITCOIN]: {
    chain: SwapChain.BITCOIN,
    displayName: 'Bitcoin',
    nativeAsset: 'BTC',
    decimals: 8,
    timeoutUnit: TimeoutUnit.BLOCK_HEIGHT,
    averageBlockTimeSeconds: 600,
    requiredConfirmations: 3,
    canBeSource: true,
    canBeTarget: false,
  },
  [SwapChain.SOLANA]: {
    chain: SwapChain.SOLANA,
    displayName: 'Solana',
    nativeAsset: 'SOL',
    decimals: 9,
    timeoutUnit: TimeoutUnit.UNIX_SECONDS,
    averageBlockTimeSeconds: 1,
    requiredConfirmations: 32,
    canBeSource: true,
    canBeTarget: false,
  },
  [SwapChain.STELLAR]: {
    chain: SwapChain.STELLAR,
    displayName: 'Stellar',
    nativeAsset: 'XLM',
    decimals: 7,
    timeoutUnit: TimeoutUnit.BLOCK_HEIGHT,
    averageBlockTimeSeconds: 5,
    requiredConfirmations: 1,
    canBeSource: false,
    canBeTarget: true,
  },
});

export const SOURCE_CHAINS: readonly SwapChain[] = Object.values(CHAIN_METADATA)
  .filter((metadata) => metadata.canBeSource)
  .map((metadata) => metadata.chain);

export function getChainMetadata(chain: SwapChain): ChainMetadata {
  return CHAIN_METADATA[chain];
}

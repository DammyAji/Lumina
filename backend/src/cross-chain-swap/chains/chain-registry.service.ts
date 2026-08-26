import { Injectable } from '@nestjs/common';
import { SwapChain } from './chain.enum';
import { HtlcChainAdapter } from './htlc-chain.adapter';
import { EthereumHtlcAdapter, PolygonHtlcAdapter } from './evm-htlc.adapter';
import { BitcoinHtlcAdapter } from './bitcoin-htlc.adapter';
import { SolanaHtlcAdapter } from './solana-htlc.adapter';
import { StellarHtlcAdapter } from './stellar-htlc.adapter';
import { SwapException } from '../../common/exceptions';

/** Resolves a chain to the adapter that speaks its HTLC protocol. */
@Injectable()
export class ChainRegistryService {
  private readonly adapters: ReadonlyMap<SwapChain, HtlcChainAdapter>;

  constructor(
    ethereum: EthereumHtlcAdapter,
    polygon: PolygonHtlcAdapter,
    bitcoin: BitcoinHtlcAdapter,
    solana: SolanaHtlcAdapter,
    stellar: StellarHtlcAdapter,
  ) {
    this.adapters = new Map<SwapChain, HtlcChainAdapter>(
      [ethereum, polygon, bitcoin, solana, stellar].map((adapter) => [adapter.chain, adapter]),
    );
  }

  get(chain: SwapChain): HtlcChainAdapter {
    const adapter = this.adapters.get(chain);

    if (!adapter) {
      throw SwapException.unsupportedChain(chain);
    }

    return adapter;
  }

  /** Adapters whose RPC and contract addresses are actually configured. */
  configuredChains(): SwapChain[] {
    return [...this.adapters.values()]
      .filter((adapter) => adapter.isConfigured())
      .map((adapter) => adapter.chain);
  }

  isConfigured(chain: SwapChain): boolean {
    return this.adapters.get(chain)?.isConfigured() ?? false;
  }
}

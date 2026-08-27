import { Injectable, Logger } from '@nestjs/common';
import { SwapChain } from './chains/chain.enum';
import { EthereumHtlcAdapter, PolygonHtlcAdapter } from './chains/evm-htlc.adapter';
import { BitcoinHtlcAdapter } from './chains/bitcoin-htlc.adapter';
import { SolanaHtlcAdapter } from './chains/solana-htlc.adapter';

const CACHE_TTL_MS = 15_000;

export interface GasQuote {
  chain: SwapChain;
  /** Chain-native fee unit: wei/gas, sat/vB, or micro-lamports/CU. */
  price: string;
  unit: string;
  /** True when `price` is above `<CHAIN>_MAX_GAS_PRICE` and claims should wait. */
  aboveCeiling: boolean;
  quotedAt: Date;
}

interface CachedQuote {
  quote: GasQuote;
  expiresAt: number;
}

/**
 * Tracks what it currently costs to broadcast on each source chain.
 *
 * Claims and refunds are time-critical — miss the timelock and the swap either
 * refunds when it should have settled, or worse, cannot refund at all — so the
 * oracle exposes a ceiling rather than a hard block: a quote above the ceiling
 * is a signal to defer a *discretionary* broadcast, never to skip a refund that
 * is running out of time.
 */
@Injectable()
export class GasPriceOracleService {
  private readonly logger = new Logger(GasPriceOracleService.name);
  private readonly cache = new Map<SwapChain, CachedQuote>();

  constructor(
    private readonly ethereum: EthereumHtlcAdapter,
    private readonly polygon: PolygonHtlcAdapter,
    private readonly bitcoin: BitcoinHtlcAdapter,
    private readonly solana: SolanaHtlcAdapter,
  ) {}

  async getQuote(chain: SwapChain): Promise<GasQuote> {
    const cached = this.cache.get(chain);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.quote;
    }

    const quote = await this.fetchQuote(chain);
    this.cache.set(chain, { quote, expiresAt: Date.now() + CACHE_TTL_MS });

    return quote;
  }

  /**
   * Whether a discretionary broadcast on `chain` should wait for cheaper fees.
   * Never consult this for a refund whose timelock is close.
   */
  async shouldDefer(chain: SwapChain): Promise<boolean> {
    try {
      return (await this.getQuote(chain)).aboveCeiling;
    } catch (error: any) {
      // A missing quote is not a reason to stall a swap.
      this.logger.warn(`Could not price gas on ${chain}, proceeding anyway: ${error.message}`);
      return false;
    }
  }

  private async fetchQuote(chain: SwapChain): Promise<GasQuote> {
    switch (chain) {
      case SwapChain.ETHEREUM:
        return this.quote(chain, await this.ethereum.getGasPrice(), 'wei_per_gas');
      case SwapChain.POLYGON:
        return this.quote(chain, await this.polygon.getGasPrice(), 'wei_per_gas');
      case SwapChain.BITCOIN:
        return this.quote(chain, BigInt(Math.ceil(await this.bitcoin.getFeeRate())), 'sat_per_vbyte');
      case SwapChain.SOLANA:
        return this.quote(chain, await this.solana.getPriorityFee(), 'micro_lamports_per_cu');
      default:
        // Stellar's fee is a flat, negligible base fee per operation.
        return this.quote(chain, 100n, 'stroops_per_operation');
    }
  }

  private quote(chain: SwapChain, price: bigint, unit: string): GasQuote {
    const ceiling = process.env[`${chain.toUpperCase()}_MAX_GAS_PRICE`];

    return {
      chain,
      price: price.toString(),
      unit,
      aboveCeiling: Boolean(ceiling) && price > BigInt(ceiling),
      quotedAt: new Date(),
    };
  }
}

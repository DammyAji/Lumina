import { Injectable, Logger } from '@nestjs/common';
import { rpc } from '@stellar/stellar-sdk';
import { CrossChainSwap } from '../entities/cross-chain-swap.entity';
import { SwapChain } from './chain.enum';
import {
  HtlcChainAdapter,
  HtlcLockRequest,
  OnChainHtlcState,
  OnChainHtlcStatus,
  UnsignedChainCall,
} from './htlc-chain.adapter';
import { MetricsService } from '../../common/metrics/metrics.service';
import { retryWithBackoff } from '../../blockchain-listener/retry.util';
import { toSmallestUnit } from './amount.util';

const QUERY_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

/**
 * Adapter for the Stellar leg, where merchants are actually paid in USDC.
 *
 * Unlike the source chains, Lumina both funds and claims this side, so its
 * state is read from the transactions the coordinator itself submitted rather
 * than by scanning for an unknown counterparty's lock.
 */
@Injectable()
export class StellarHtlcAdapter implements HtlcChainAdapter {
  readonly chain = SwapChain.STELLAR;
  private readonly logger = new Logger(StellarHtlcAdapter.name);
  private server: rpc.Server | null = null;

  constructor(private readonly metricsService: MetricsService) {}

  isConfigured(): boolean {
    return Boolean(process.env.STELLAR_HTLC_CONTRACT_ID);
  }

  /** Stellar timelocks are ledger sequence numbers. */
  async getTimeoutReference(): Promise<number> {
    const latest = await this.track('get_latest_ledger', () =>
      this.rpcServer().getLatestLedger(),
    );

    return latest.sequence;
  }

  async getHtlcState(swap: CrossChainSwap): Promise<OnChainHtlcState | null> {
    if (!swap.target_lock_tx) {
      return null;
    }

    const lock = await this.transactionSucceeded(swap.target_lock_tx);

    if (!lock) {
      return null;
    }

    const claimed = swap.target_claim_tx
      ? await this.transactionSucceeded(swap.target_claim_tx)
      : false;

    const refunded = !claimed && swap.refund_tx
      ? await this.transactionSucceeded(swap.refund_tx)
      : false;

    return {
      status: claimed
        ? OnChainHtlcStatus.CLAIMED
        : refunded
          ? OnChainHtlcStatus.REFUNDED
          : OnChainHtlcStatus.LOCKED,
      amount: toSmallestUnit(swap.target_amount ?? swap.amount, this.chain).toString(),
      secretHash: swap.secret_hash,
      timeout: swap.target_timeout_block ?? swap.timeout_block,
      // Stellar ledgers close with immediate finality, so a successful
      // transaction needs no confirmation depth.
      confirmations: 1,
      preimage: null,
      txHash: swap.target_lock_tx,
    };
  }

  buildLockRequest(swap: CrossChainSwap): HtlcLockRequest {
    return {
      chain: this.chain,
      htlcAddress: this.contractId(),
      amount: toSmallestUnit(swap.target_amount ?? swap.amount, this.chain).toString(),
      secretHash: swap.secret_hash,
      timeout: swap.target_timeout_block ?? swap.timeout_block,
      payload: null,
      metadata: {
        function: 'lock',
        recipient: swap.target_address,
        asset: swap.target_asset,
      },
    };
  }

  buildClaimCall(swap: CrossChainSwap, secretHex: string): UnsignedChainCall {
    return {
      chain: this.chain,
      to: this.contractId(),
      data: 'claim',
      value: '0',
      metadata: { swapId: swap.swap_id, preimage: secretHex },
    };
  }

  buildRefundCall(swap: CrossChainSwap): UnsignedChainCall {
    return {
      chain: this.chain,
      to: this.contractId(),
      data: 'refund',
      value: '0',
      metadata: { swapId: swap.swap_id },
    };
  }

  private async transactionSucceeded(hash: string): Promise<boolean> {
    try {
      const result = await this.track('get_transaction', () =>
        this.rpcServer().getTransaction(hash),
      );

      return result.status === rpc.Api.GetTransactionStatus.SUCCESS;
    } catch (error: any) {
      this.logger.warn(`Could not read Stellar transaction ${hash}: ${error.message}`);
      return false;
    }
  }

  private track<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return this.metricsService.trackExternalCall('stellar_rpc', operation, () =>
      retryWithBackoff(fn, { maxAttempts: MAX_ATTEMPTS, timeoutMs: QUERY_TIMEOUT_MS }),
    );
  }

  private rpcServer(): rpc.Server {
    if (!this.server) {
      const url = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
      this.server = new rpc.Server(url, { allowHttp: !url.startsWith('https') });
    }

    return this.server;
  }

  private contractId(): string {
    const contractId = process.env.STELLAR_HTLC_CONTRACT_ID;

    if (!contractId) {
      throw new Error('Stellar swaps are not configured; set STELLAR_HTLC_CONTRACT_ID');
    }

    return contractId;
  }
}

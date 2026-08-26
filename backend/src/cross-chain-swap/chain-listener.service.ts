import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { CrossChainSwapService } from './cross-chain-swap.service';
import { ChainRegistryService } from './chains/chain-registry.service';
import { CrossChainSwap, SwapStatus } from './entities/cross-chain-swap.entity';
import { DistributedLockService } from '../distributed-ledger/services/distributed-lock.service';

const LOCK_TTL_MS = 60_000;

/**
 * Polls every configured chain and drives each in-flight swap forward.
 *
 * Swaps are advanced under a per-swap distributed lock, so several backend
 * replicas can run this listener at once without two of them broadcasting the
 * same claim.
 */
@Injectable()
export class ChainListenerService {
  private readonly logger = new Logger(ChainListenerService.name);
  private readonly instanceId = randomUUID();
  private isPolling = false;

  constructor(
    private readonly swaps: CrossChainSwapService,
    private readonly chains: ChainRegistryService,
    private readonly locks: DistributedLockService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async monitorSwaps(): Promise<void> {
    if (this.isPolling) {
      this.logger.warn('Skipping poll cycle: previous cycle is still in progress');
      return;
    }

    this.isPolling = true;

    try {
      const active = await this.swaps.findActive();
      const due = active.filter((swap) => this.isDue(swap));

      if (due.length === 0) {
        return;
      }

      this.logger.log(`Advancing ${due.length} active swap(s)`);

      // Chains are independent, so a slow or failing RPC on one never holds up
      // the others.
      await Promise.allSettled(due.map((swap) => this.advanceOne(swap)));
    } catch (error: any) {
      this.logger.error(`Swap poll cycle failed: ${error.message}`, error.stack);
    } finally {
      this.isPolling = false;
    }
  }

  private async advanceOne(swap: CrossChainSwap): Promise<void> {
    if (!this.chains.isConfigured(swap.source_chain)) {
      this.logger.warn(
        `Swap ${swap.swap_id} is on ${swap.source_chain}, which is no longer configured; skipping`,
      );
      return;
    }

    try {
      await this.locks.withLock(
        `swap:${swap.swap_id}`,
        this.instanceId,
        () => this.swaps.advance(swap),
        // One attempt only: another replica holding the lock means this swap is
        // already being advanced, and it will be picked up again next cycle.
        { ttl: LOCK_TTL_MS, maxRetries: 1 },
      );
    } catch (error: any) {
      this.logger.warn(`Could not advance swap ${swap.swap_id}: ${error.message}`);
    }
  }

  /** Swaps in backoff wait for their retry time before being touched again. */
  private isDue(swap: CrossChainSwap): boolean {
    if (swap.status === SwapStatus.REFUND_PENDING) {
      // The refund service owns this state.
      return false;
    }

    return !swap.next_retry_at || swap.next_retry_at <= new Date();
  }
}

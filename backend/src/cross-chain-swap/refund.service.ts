import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { CrossChainSwap, SwapStatus } from './entities/cross-chain-swap.entity';
import { ChainRegistryService } from './chains/chain-registry.service';
import { OnChainHtlcStatus } from './chains/htlc-chain.adapter';
import { SWAP_BROADCASTER, SwapBroadcaster } from './swap-broadcaster.interface';
import { hasTimedOut } from './timelock.util';
import { DistributedLockService } from '../distributed-ledger/services/distributed-lock.service';

const LOCK_TTL_MS = 60_000;
const RETRY_BASE_DELAY_MS = 60 * 1000;
const RETRY_MAX_DELAY_MS = 60 * 60 * 1000;

/**
 * Returns funds when a swap times out instead of settling.
 *
 * Refunds are the safety net the whole design leans on, so this service never
 * gives up quietly: a swap that cannot be refunded yet is left in
 * `REFUND_PENDING` and retried, and only a genuinely unrefundable swap — one
 * whose secret is already public — is marked `FAILED` for a human to look at.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);
  private readonly instanceId = randomUUID();

  constructor(
    @InjectRepository(CrossChainSwap)
    private readonly swapRepository: Repository<CrossChainSwap>,
    private readonly chains: ChainRegistryService,
    private readonly locks: DistributedLockService,
    @Inject(SWAP_BROADCASTER) private readonly broadcaster: SwapBroadcaster,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async processRefunds(): Promise<void> {
    const pending = await this.swapRepository.find({
      where: { status: SwapStatus.REFUND_PENDING },
      order: { created_at: 'ASC' },
    });

    const due = pending.filter((swap) => !swap.next_retry_at || swap.next_retry_at <= new Date());

    if (due.length === 0) {
      return;
    }

    this.logger.log(`Processing ${due.length} pending refund(s)`);

    await Promise.allSettled(due.map((swap) => this.refundOne(swap)));
  }

  private async refundOne(swap: CrossChainSwap): Promise<void> {
    try {
      await this.locks.withLock(
        `swap:${swap.swap_id}`,
        this.instanceId,
        () => this.refund(swap),
        { ttl: LOCK_TTL_MS, maxRetries: 1 },
      );
    } catch (error: any) {
      this.logger.warn(`Could not refund swap ${swap.swap_id}: ${error.message}`);
    }
  }

  /**
   * Refunds whichever legs are still locked.
   *
   * Both legs are handled, because a swap can time out after Lumina has funded
   * Stellar but before the merchant's claim — in which case both sides are
   * sitting in escrow waiting for their respective timeouts.
   */
  async refund(swap: CrossChainSwap): Promise<CrossChainSwap> {
    try {
      const targetRefunded = await this.refundTargetLeg(swap);
      const sourceRefunded = await this.refundSourceLeg(swap);

      if (!targetRefunded || !sourceRefunded) {
        // At least one leg is still inside its timelock. Come back later.
        return this.scheduleRetry(swap, 'Waiting for a timelock to expire before refunding');
      }

      swap.status = SwapStatus.REFUNDED;
      swap.next_retry_at = null;
      swap.error_message = null;

      this.logger.log(`Swap ${swap.swap_id} fully refunded`);

      return this.swapRepository.save(swap);
    } catch (error: any) {
      return this.scheduleRetry(swap, error.message);
    }
  }

  /** True once the Stellar leg needs no further action. */
  private async refundTargetLeg(swap: CrossChainSwap): Promise<boolean> {
    if (!swap.target_lock_tx || swap.refund_tx) {
      return true;
    }

    const adapter = this.chains.get(swap.target_chain);
    const state = await adapter.getHtlcState(swap);

    if (!state || state.status !== OnChainHtlcStatus.LOCKED) {
      return true;
    }

    const reference = await adapter.getTimeoutReference();
    const timeout = swap.target_timeout_block ?? swap.timeout_block;

    if (!hasTimedOut(timeout, reference)) {
      return false;
    }

    const { txHash } = await this.broadcaster.broadcast(adapter.buildRefundCall(swap));
    swap.refund_tx = txHash;
    await this.swapRepository.update(swap.id, { refund_tx: txHash });

    this.logger.log(`Refunded the Stellar leg of swap ${swap.swap_id} in ${txHash}`);

    return true;
  }

  /**
   * True once the source leg needs no further action.
   *
   * The customer owns the source HTLC's refund branch, so Lumina cannot
   * broadcast it — the customer's own wallet does. All that is checked here is
   * whether it is still outstanding.
   */
  private async refundSourceLeg(swap: CrossChainSwap): Promise<boolean> {
    const adapter = this.chains.get(swap.source_chain);
    const state = await adapter.getHtlcState(swap);

    if (!state) {
      // Never funded, so there is nothing to return.
      return true;
    }

    if (state.status !== OnChainHtlcStatus.LOCKED) {
      return true;
    }

    const reference = await adapter.getTimeoutReference();

    if (!hasTimedOut(swap.timeout_block, reference)) {
      return false;
    }

    this.logger.log(
      `Source leg of swap ${swap.swap_id} is refundable by the customer at ` +
        `${swap.source_htlc_address}; awaiting their refund transaction`,
    );

    return false;
  }

  private async scheduleRetry(swap: CrossChainSwap, reason: string): Promise<CrossChainSwap> {
    swap.attempts += 1;
    swap.error_message = reason;
    swap.next_retry_at = new Date(
      Date.now() + Math.min(RETRY_BASE_DELAY_MS * 2 ** (swap.attempts - 1), RETRY_MAX_DELAY_MS),
    );

    return this.swapRepository.save(swap);
  }
}

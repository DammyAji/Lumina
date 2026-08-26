import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';
import {
  CrossChainSwap,
  REFUNDABLE_STATUSES,
  SwapStatus,
  TERMINAL_STATUSES,
} from './entities/cross-chain-swap.entity';
import { CHAIN_METADATA, getChainMetadata, SwapChain, SOURCE_CHAINS } from './chains/chain.enum';
import { ChainRegistryService } from './chains/chain-registry.service';
import {
  HtlcLockRequest,
  OnChainHtlcState,
  OnChainHtlcStatus,
} from './chains/htlc-chain.adapter';
import { toSmallestUnit } from './chains/amount.util';
import { SecretManagerService } from './secret-manager.service';
import { GasPriceOracleService } from './gas-price-oracle.service';
import { InitiateSwapDto } from './dto/initiate-swap.dto';
import { SWAP_BROADCASTER, SwapBroadcaster } from './swap-broadcaster.interface';
import { hasTimedOut, planTimelocks, secondsUntilTimeout } from './timelock.util';
import { SwapException } from '../common/exceptions';
import { MetricsService } from '../common/metrics/metrics.service';

const DEFAULT_SOURCE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_TARGET_TTL_SECONDS = 12 * 60 * 60;
const RETRY_BASE_DELAY_MS = 30 * 1000;
const RETRY_MAX_DELAY_MS = 30 * 60 * 1000;

/**
 * A swap as the API returns it. The secret and its ciphertext are deliberately
 * absent — revealing either before the merchant's claim would let anyone drain
 * the source leg.
 */
export type SwapView = Omit<CrossChainSwap, 'encrypted_secret'>;

export interface InitiatedSwap {
  swap: SwapView;
  /** What the customer must do on the source chain to fund their leg. */
  lockRequest: HtlcLockRequest;
}

/**
 * Drives a swap from "customer wants to pay in ETH" to "merchant holds USDC".
 *
 * The state machine is deliberately re-entrant: `advance` reads the chains,
 * decides on the single next step, and takes it. Running it twice on the same
 * swap is a no-op rather than a double spend, which is what lets the listener
 * poll on a timer and lets failures simply be retried.
 */
@Injectable()
export class CrossChainSwapService {
  private readonly logger = new Logger(CrossChainSwapService.name);

  constructor(
    @InjectRepository(CrossChainSwap)
    private readonly swapRepository: Repository<CrossChainSwap>,
    private readonly chains: ChainRegistryService,
    private readonly secrets: SecretManagerService,
    private readonly gasOracle: GasPriceOracleService,
    private readonly metricsService: MetricsService,
    @Inject(SWAP_BROADCASTER) private readonly broadcaster: SwapBroadcaster,
  ) {}

  /** Networks this deployment can actually swap from, and their parameters. */
  supportedChains() {
    return SOURCE_CHAINS.map((chain) => ({
      ...getChainMetadata(chain),
      configured: this.chains.isConfigured(chain),
    }));
  }

  /**
   * Creates a swap and returns everything the customer needs to fund it.
   *
   * Nothing is broadcast here: the customer funds the source HTLC themselves,
   * and the listener picks the swap up once that lock confirms.
   */
  async initiate(dto: InitiateSwapDto): Promise<InitiatedSwap> {
    const metadata = CHAIN_METADATA[dto.source_chain];

    if (!metadata?.canBeSource) {
      throw SwapException.unsupportedChain(dto.source_chain);
    }

    if (!this.chains.isConfigured(dto.source_chain)) {
      throw SwapException.chainNotConfigured(dto.source_chain);
    }

    const sourceAdapter = this.chains.get(dto.source_chain);
    const targetAdapter = this.chains.get(SwapChain.STELLAR);

    const [sourceReference, targetReference] = await Promise.all([
      sourceAdapter.getTimeoutReference(),
      targetAdapter.getTimeoutReference(),
    ]);

    const timelocks = planTimelocks({
      sourceChain: dto.source_chain,
      sourceReference,
      targetReference,
      sourceTtlSeconds: this.envSeconds('SWAP_SOURCE_TIMEOUT_SECONDS', DEFAULT_SOURCE_TTL_SECONDS),
      targetTtlSeconds: this.envSeconds('SWAP_TARGET_TIMEOUT_SECONDS', DEFAULT_TARGET_TTL_SECONDS),
      now: new Date(),
    });

    const { secretHash, encryptedSecret } = this.secrets.generateSecret();

    const swap = await this.swapRepository.save(
      this.swapRepository.create({
        swap_id: randomBytes(32).toString('hex'),
        source_chain: dto.source_chain,
        target_chain: SwapChain.STELLAR,
        source_address: dto.source_address,
        target_address: dto.target_address,
        amount: dto.amount,
        source_asset: dto.source_asset,
        target_asset: 'USDC',
        secret_hash: secretHash,
        encrypted_secret: encryptedSecret,
        timeout_block: timelocks.sourceTimeout,
        target_timeout_block: timelocks.targetTimeout,
        status: SwapStatus.PENDING,
      }),
    );

    const lockRequest = sourceAdapter.buildLockRequest(swap);
    swap.source_htlc_address = lockRequest.htlcAddress;
    await this.swapRepository.update(swap.id, { source_htlc_address: lockRequest.htlcAddress });

    this.logger.log(
      `Swap ${swap.swap_id} initiated on ${dto.source_chain}, source timelock ${timelocks.sourceTimeout}`,
    );

    return { swap: this.toView(swap), lockRequest };
  }

  async findBySwapId(swapId: string): Promise<SwapView> {
    return this.toView(await this.requireSwap(swapId));
  }

  /** Swaps the listener still has work to do on. */
  async findActive(): Promise<CrossChainSwap[]> {
    return this.swapRepository.find({
      where: { status: Not(In(TERMINAL_STATUSES as SwapStatus[])) },
      order: { created_at: 'ASC' },
    });
  }

  /**
   * Marks a swap for refund at the customer's request.
   *
   * Only allowed once the source timelock has actually expired — the HTLC would
   * reject the refund before then anyway, and accepting the request earlier
   * would strand the swap in a state the chains disagree with.
   */
  async requestRefund(swapId: string): Promise<SwapView> {
    const swap = await this.requireSwap(swapId);

    if (!REFUNDABLE_STATUSES.includes(swap.status)) {
      throw SwapException.notRefundable(swapId, swap.status);
    }

    const reference = await this.chains.get(swap.source_chain).getTimeoutReference();

    if (!hasTimedOut(swap.timeout_block, reference)) {
      throw SwapException.timelockNotExpired(swapId, swap.timeout_block);
    }

    swap.status = SwapStatus.REFUND_PENDING;
    swap.next_retry_at = null;
    await this.swapRepository.save(swap);

    this.logger.log(`Swap ${swapId} marked for refund at source reference ${reference}`);

    return this.toView(swap);
  }

  /**
   * Takes the single next step for `swap`, based on what the chains say right
   * now. Safe to call repeatedly; each state only moves forward once its
   * on-chain precondition is actually met.
   */
  async advance(swap: CrossChainSwap): Promise<CrossChainSwap> {
    try {
      switch (swap.status) {
        case SwapStatus.PENDING:
          return await this.awaitSourceLock(swap);
        case SwapStatus.SOURCE_LOCKED:
          return await this.lockTarget(swap);
        case SwapStatus.TARGET_LOCKED:
          return await this.claimTarget(swap);
        case SwapStatus.TARGET_CLAIMED:
          return await this.claimSource(swap);
        default:
          return swap;
      }
    } catch (error: any) {
      return this.scheduleRetry(swap, error);
    }
  }

  /** Waits for the customer's lock to appear and confirm on the source chain. */
  private async awaitSourceLock(swap: CrossChainSwap): Promise<CrossChainSwap> {
    const adapter = this.chains.get(swap.source_chain);
    const [state, reference] = await Promise.all([
      adapter.getHtlcState(swap),
      adapter.getTimeoutReference(),
    ]);

    if (!state) {
      // Nothing on-chain yet. Once the timelock passes there is nothing left to
      // wait for: no funds were ever locked, so the swap simply expires.
      if (hasTimedOut(swap.timeout_block, reference)) {
        return this.transition(swap, SwapStatus.EXPIRED, 'Customer never funded the source HTLC');
      }

      return swap;
    }

    this.assertMatchesSwap(swap, state);

    const required = CHAIN_METADATA[swap.source_chain].requiredConfirmations;

    if (state.confirmations < required) {
      this.logger.debug(
        `Swap ${swap.swap_id}: ${state.confirmations}/${required} confirmations on ${swap.source_chain}`,
      );
      return swap;
    }

    // Too little time left to fund and claim the Stellar leg before the source
    // side becomes refundable, so let the customer take their funds back.
    if (secondsUntilTimeout(swap.source_chain, swap.timeout_block, reference) <= 0) {
      return this.transition(swap, SwapStatus.REFUND_PENDING, 'Source timelock expired while confirming');
    }

    swap.source_lock_tx = state.txHash;
    return this.transition(swap, SwapStatus.SOURCE_LOCKED);
  }

  /** Funds the Stellar HTLC that pays the merchant. */
  private async lockTarget(swap: CrossChainSwap): Promise<CrossChainSwap> {
    const adapter = this.chains.get(SwapChain.STELLAR);
    const lockRequest = adapter.buildLockRequest(swap);

    const { txHash } = await this.broadcaster.broadcast({
      chain: SwapChain.STELLAR,
      to: lockRequest.htlcAddress,
      data: 'lock',
      value: lockRequest.amount,
      metadata: {
        swapId: swap.swap_id,
        recipient: swap.target_address,
        secretHash: swap.secret_hash,
        timeout: lockRequest.timeout,
      },
    });

    swap.target_lock_tx = txHash;
    return this.transition(swap, SwapStatus.TARGET_LOCKED);
  }

  /**
   * Claims the merchant's Stellar leg with the secret.
   *
   * This is the point of no return: the claim publishes the preimage on-chain,
   * after which the swap can only complete, never refund.
   */
  private async claimTarget(swap: CrossChainSwap): Promise<CrossChainSwap> {
    const adapter = this.chains.get(SwapChain.STELLAR);
    const state = await adapter.getHtlcState(swap);

    if (state?.status === OnChainHtlcStatus.CLAIMED) {
      return this.transition(swap, SwapStatus.TARGET_CLAIMED);
    }

    const reference = await adapter.getTimeoutReference();
    const timeout = swap.target_timeout_block ?? swap.timeout_block;

    if (hasTimedOut(timeout, reference)) {
      return this.transition(swap, SwapStatus.REFUND_PENDING, 'Target timelock expired before claim');
    }

    const secret = this.secrets.decrypt(swap.encrypted_secret);
    const { txHash } = await this.broadcaster.broadcast(adapter.buildClaimCall(swap, secret));

    swap.target_claim_tx = txHash;
    return this.transition(swap, SwapStatus.TARGET_CLAIMED);
  }

  /** Claims the customer's source leg, which is what Lumina is paid with. */
  private async claimSource(swap: CrossChainSwap): Promise<CrossChainSwap> {
    const adapter = this.chains.get(swap.source_chain);
    const state = await adapter.getHtlcState(swap);

    if (state?.status === OnChainHtlcStatus.CLAIMED) {
      return this.transition(swap, SwapStatus.COMPLETED);
    }

    const reference = await adapter.getTimeoutReference();

    if (hasTimedOut(swap.timeout_block, reference)) {
      // The secret is already public, so the customer can no longer refund
      // either — but Lumina has lost the race and must reconcile by hand.
      return this.transition(
        swap,
        SwapStatus.FAILED,
        'Source timelock expired after the secret was revealed; manual reconciliation required',
      );
    }

    // Fees only matter while there is time to wait for them to come down.
    if (await this.gasOracle.shouldDefer(swap.source_chain)) {
      this.logger.log(`Deferring source claim for swap ${swap.swap_id}: gas above ceiling`);
      return swap;
    }

    const secret = this.secrets.decrypt(swap.encrypted_secret);
    const { txHash } = await this.broadcaster.broadcast(adapter.buildClaimCall(swap, secret));

    swap.source_claim_tx = txHash;
    return this.transition(swap, SwapStatus.COMPLETED);
  }

  /**
   * Rejects a lock that does not match what the swap agreed to. A different
   * hashlock or a short payment would leave Lumina paying out more on Stellar
   * than it can ever claim back.
   */
  private assertMatchesSwap(swap: CrossChainSwap, state: OnChainHtlcState): void {
    if (state.secretHash.toLowerCase() !== swap.secret_hash.toLowerCase()) {
      throw SwapException.hashlockMismatch(swap.swap_id);
    }

    const expected = toSmallestUnit(swap.amount, swap.source_chain);

    if (BigInt(state.amount) < expected) {
      throw SwapException.amountMismatch(swap.swap_id, expected.toString(), state.amount);
    }
  }

  private async transition(
    swap: CrossChainSwap,
    status: SwapStatus,
    reason?: string,
  ): Promise<CrossChainSwap> {
    const previous = swap.status;
    swap.status = status;
    swap.error_message = reason ?? null;
    swap.next_retry_at = null;

    if (status !== SwapStatus.REFUND_PENDING && status !== SwapStatus.FAILED) {
      swap.attempts = 0;
    }

    // Recorded before the save so the duration is the time spent in `previous`.
    const secondsInPreviousState = swap.updated_at
      ? (Date.now() - swap.updated_at.getTime()) / 1000
      : 0;
    const saved = await this.swapRepository.save(swap);

    this.logger.log(
      `Swap ${swap.swap_id}: ${previous} -> ${status}${reason ? ` (${reason})` : ''}`,
    );
    this.metricsService.recordBlockchainTx(
      swap.source_chain,
      'swap_transition',
      status,
      secondsInPreviousState,
    );

    return saved;
  }

  /**
   * Backs a failed step off exponentially, and gives up into the refund path
   * rather than leaving the swap wedged once the attempts are exhausted.
   */
  private async scheduleRetry(swap: CrossChainSwap, error: Error): Promise<CrossChainSwap> {
    swap.attempts += 1;
    swap.error_message = error.message;

    if (swap.attempts >= swap.max_attempts) {
      swap.status = REFUNDABLE_STATUSES.includes(swap.status)
        ? SwapStatus.REFUND_PENDING
        : SwapStatus.FAILED;
      swap.next_retry_at = null;
      this.logger.error(
        `Swap ${swap.swap_id} exhausted ${swap.max_attempts} attempts, moving to ${swap.status}: ${error.message}`,
      );
    } else {
      swap.next_retry_at = new Date(
        Date.now() + Math.min(RETRY_BASE_DELAY_MS * 2 ** (swap.attempts - 1), RETRY_MAX_DELAY_MS),
      );
      this.logger.warn(
        `Swap ${swap.swap_id} attempt ${swap.attempts} failed, retrying after ${swap.next_retry_at.toISOString()}: ${error.message}`,
      );
    }

    return this.swapRepository.save(swap);
  }

  private async requireSwap(swapId: string): Promise<CrossChainSwap> {
    const swap = await this.swapRepository.findOne({ where: { swap_id: swapId } });

    if (!swap) {
      throw SwapException.notFound(swapId);
    }

    return swap;
  }

  private toView(swap: CrossChainSwap): SwapView {
    const { encrypted_secret, ...view } = swap;
    return view;
  }

  private envSeconds(key: string, fallback: number): number {
    return parseInt(process.env[key] || '', 10) || fallback;
  }
}

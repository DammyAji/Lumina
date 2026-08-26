import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { SwapChain } from '../chains/chain.enum';

/**
 * Lifecycle of a cross-chain swap.
 *
 * The happy path is
 * `pending -> source_locked -> target_locked -> target_claimed -> completed`.
 * Any state before `target_claimed` can fall back to the refund path, because
 * up to that point no secret has been revealed and both legs are still
 * independently refundable once their timelocks expire.
 */
export enum SwapStatus {
  /** Swap created; waiting for the customer to fund the source HTLC. */
  PENDING = 'pending',
  /** Source HTLC funded and confirmed to the chain's reorg depth. */
  SOURCE_LOCKED = 'source_locked',
  /** Lumina has funded the Stellar HTLC that pays the merchant. */
  TARGET_LOCKED = 'target_locked',
  /** Merchant claimed on Stellar; the secret is now public on-chain. */
  TARGET_CLAIMED = 'target_claimed',
  /** Lumina claimed the source leg with the revealed secret. Terminal. */
  COMPLETED = 'completed',
  /** A timelock expired; refunds are being broadcast. */
  REFUND_PENDING = 'refund_pending',
  /** Funds returned to their original owners. Terminal. */
  REFUNDED = 'refunded',
  /** Customer never funded the source HTLC before the deadline. Terminal. */
  EXPIRED = 'expired',
  /** Unrecoverable: retries exhausted and no refund path is available. Terminal. */
  FAILED = 'failed',
}

/** States from which a swap can still be refunded rather than completed. */
export const REFUNDABLE_STATUSES: readonly SwapStatus[] = [
  SwapStatus.PENDING,
  SwapStatus.SOURCE_LOCKED,
  SwapStatus.TARGET_LOCKED,
  SwapStatus.REFUND_PENDING,
];

/** States that no longer change on their own. */
export const TERMINAL_STATUSES: readonly SwapStatus[] = [
  SwapStatus.COMPLETED,
  SwapStatus.REFUNDED,
  SwapStatus.EXPIRED,
  SwapStatus.FAILED,
];

@Entity('cross_chain_swaps')
@Index(['status'])
@Index(['source_chain', 'status'])
export class CrossChainSwap {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * 32-byte swap identifier (hex, no `0x`) shared by both HTLCs. Assigned by
   * the coordinator rather than derived on-chain, so both legs agree on it
   * before either is funded.
   */
  @Column({ unique: true, length: 64 })
  swap_id: string;

  @Column({ type: 'enum', enum: SwapChain })
  source_chain: SwapChain;

  @Column({ type: 'enum', enum: SwapChain, default: SwapChain.STELLAR })
  target_chain: SwapChain;

  /** Where the customer's funds come from on the source chain. */
  @Column({ length: 255 })
  source_address: string;

  /** Merchant's Stellar account, paid in USDC. */
  @Column({ length: 255 })
  target_address: string;

  /** Contract, program, or script address holding the source-chain escrow. */
  @Column({ length: 255, nullable: true })
  source_htlc_address: string | null;

  @Column('decimal', { precision: 36, scale: 18 })
  amount: string;

  @Column({ length: 20 })
  source_asset: string;

  @Column({ length: 20, default: 'USDC' })
  target_asset: string;

  /** Amount of `target_asset` the merchant receives, once conversion is priced. */
  @Column('decimal', { precision: 36, scale: 18, nullable: true })
  target_amount: string | null;

  /** sha256(secret), hex, no `0x`. Identical on both legs. */
  @Column({ length: 64 })
  secret_hash: string;

  /**
   * The secret, encrypted at rest. Never returned by the API — it is only
   * released on-chain by the claim that reveals it.
   */
  @Column({ type: 'text', nullable: true })
  encrypted_secret: string | null;

  /** Source-chain timelock, in that chain's own unit (height or unix seconds). */
  @Column('bigint')
  timeout_block: string;

  /**
   * Stellar-side timelock. Always earlier than `timeout_block` so the merchant's
   * leg expires first and the customer can never refund a swap that Lumina can
   * still claim.
   */
  @Column('bigint', { nullable: true })
  target_timeout_block: string | null;

  @Column({ type: 'enum', enum: SwapStatus, default: SwapStatus.PENDING })
  status: SwapStatus;

  @Column({ length: 255, nullable: true })
  source_lock_tx: string | null;

  @Column({ length: 255, nullable: true })
  target_lock_tx: string | null;

  @Column({ length: 255, nullable: true })
  target_claim_tx: string | null;

  @Column({ length: 255, nullable: true })
  source_claim_tx: string | null;

  @Column({ length: 255, nullable: true })
  refund_tx: string | null;

  /** Payment this swap settles, when the swap was started from a payment. */
  @Column({ nullable: true })
  payment_id: string | null;

  @Column({ default: 0 })
  attempts: number;

  @Column({ default: 5 })
  max_attempts: number;

  @Column({ type: 'timestamp', nullable: true })
  next_retry_at: Date | null;

  @Column({ type: 'text', nullable: true })
  error_message: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

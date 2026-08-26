import { Injectable } from '@nestjs/common';
import { CrossChainSwap } from '../entities/cross-chain-swap.entity';
import { CHAIN_METADATA, SwapChain } from './chain.enum';
import {
  HtlcChainAdapter,
  HtlcLockRequest,
  OnChainHtlcState,
  OnChainHtlcStatus,
  UnsignedChainCall,
} from './htlc-chain.adapter';
import { JsonRpcClient } from './json-rpc.client';
import { base58Decode, findProgramAddress } from './solana-pda.util';
import { toSmallestUnit } from './amount.util';

/** Instruction tags from `smartcontracts/solana/htlc_program/src/instruction.rs`. */
const INSTRUCTION_TAG = { LOCK: 0, CLAIM: 1, REFUND: 2 } as const;

/** Seed prefix used by the program's `swap_pda` helper. */
const SWAP_SEED_PREFIX = Buffer.from('swap', 'utf8');

/** Byte offsets of `HtlcSwap` in `state.rs`. Layout is fixed-size by design. */
const OFFSETS = {
  swapId: 0,
  sender: 32,
  recipient: 64,
  vault: 96,
  amount: 128,
  secretHash: 136,
  timeout: 168,
  status: 176,
  preimage: 177,
} as const;

const ACCOUNT_LEN = 209;

/** `SwapStatus` discriminants; 0 means the account was never initialised. */
const ACCOUNT_STATUS = [null, 'locked', 'claimed', 'refunded'] as const;

/**
 * Adapter for the Solana leg.
 *
 * Solana speaks JSON-RPC, so the module reads the swap account directly and
 * decodes it with the same fixed layout the on-chain program writes, rather
 * than depending on @solana/web3.js.
 */
@Injectable()
export class SolanaHtlcAdapter implements HtlcChainAdapter {
  readonly chain = SwapChain.SOLANA;

  constructor(private readonly rpc: JsonRpcClient) {}

  isConfigured(): boolean {
    return Boolean(
      process.env.SOLANA_RPC_URL &&
        process.env.SOLANA_HTLC_PROGRAM_ID &&
        process.env.SOLANA_SWAP_RECIPIENT,
    );
  }

  /** Solana timelocks are unix seconds, matching the program's `Clock`. */
  async getTimeoutReference(): Promise<number> {
    const slot = await this.rpc.call<number>(this.chain, this.rpcUrl(), 'getSlot', []);
    const blockTime = await this.rpc.call<number | null>(this.chain, this.rpcUrl(), 'getBlockTime', [
      slot,
    ]);

    // A slot that has not been finalised yet has no block time.
    return blockTime ?? Math.floor(Date.now() / 1000);
  }

  async getHtlcState(swap: CrossChainSwap): Promise<OnChainHtlcState | null> {
    const response = await this.rpc.call<{
      value: { data: [string, string] } | null;
      context: { slot: number };
    }>(this.chain, this.rpcUrl(), 'getAccountInfo', [
      this.swapAccount(swap).address,
      { encoding: 'base64', commitment: 'confirmed' },
    ]);

    if (!response?.value) {
      return null;
    }

    const data = Buffer.from(response.value.data[0], 'base64');

    if (data.length < ACCOUNT_LEN) {
      return null;
    }

    const status = ACCOUNT_STATUS[data.readUInt8(OFFSETS.status)];

    if (!status) {
      return null;
    }

    const preimage = data.subarray(OFFSETS.preimage, OFFSETS.preimage + 32).toString('hex');

    return {
      status: status as OnChainHtlcStatus,
      amount: data.readBigUInt64LE(OFFSETS.amount).toString(),
      secretHash: data.subarray(OFFSETS.secretHash, OFFSETS.secretHash + 32).toString('hex'),
      timeout: data.readBigInt64LE(OFFSETS.timeout).toString(),
      // Solana has no reorgs past a confirmed slot, so a readable account at
      // `confirmed` commitment already counts as confirmed.
      confirmations: CHAIN_METADATA[this.chain].requiredConfirmations,
      preimage: preimage === '0'.repeat(64) ? null : preimage,
      txHash: swap.source_lock_tx,
    };
  }

  buildLockRequest(swap: CrossChainSwap): HtlcLockRequest {
    const account = this.swapAccount(swap);
    const amount = toSmallestUnit(swap.amount, this.chain);

    const data = Buffer.concat([
      Buffer.from([INSTRUCTION_TAG.LOCK]),
      Buffer.from(swap.swap_id, 'hex'),
      Buffer.from(base58Decode(this.recipient())),
      this.u64(amount),
      Buffer.from(swap.secret_hash, 'hex'),
      this.i64(BigInt(swap.timeout_block)),
    ]);

    return {
      chain: this.chain,
      htlcAddress: this.programId(),
      amount: amount.toString(),
      secretHash: swap.secret_hash,
      timeout: swap.timeout_block,
      payload: data.toString('base64'),
      metadata: {
        programId: this.programId(),
        swapAccount: account.address,
        bump: String(account.bump),
        recipient: this.recipient(),
      },
    };
  }

  buildClaimCall(swap: CrossChainSwap, secretHex: string): UnsignedChainCall {
    return this.buildCall(
      swap,
      Buffer.concat([Buffer.from([INSTRUCTION_TAG.CLAIM]), Buffer.from(secretHex, 'hex')]),
    );
  }

  buildRefundCall(swap: CrossChainSwap): UnsignedChainCall {
    return this.buildCall(swap, Buffer.from([INSTRUCTION_TAG.REFUND]));
  }

  /** Recent prioritisation fee in micro-lamports per compute unit. */
  async getPriorityFee(): Promise<bigint> {
    const fees = await this.rpc.call<Array<{ prioritizationFee: number }>>(
      this.chain,
      this.rpcUrl(),
      'getRecentPrioritizationFees',
      [[]],
    );

    if (!fees?.length) {
      return 0n;
    }

    // The median is steadier than the max, which spikes on a single hot account.
    const sorted = fees.map((fee) => fee.prioritizationFee).sort((a, b) => a - b);

    return BigInt(sorted[Math.floor(sorted.length / 2)]);
  }

  /** PDA holding the swap state and owning its token vault. */
  swapAccount(swap: CrossChainSwap) {
    return findProgramAddress(
      [SWAP_SEED_PREFIX, Buffer.from(swap.swap_id, 'hex')],
      this.programId(),
    );
  }

  private buildCall(swap: CrossChainSwap, data: Buffer): UnsignedChainCall {
    const account = this.swapAccount(swap);

    return {
      chain: this.chain,
      to: this.programId(),
      data: data.toString('base64'),
      value: '0',
      metadata: { swapAccount: account.address, bump: String(account.bump) },
    };
  }

  private rpcUrl(): string {
    return this.requireEnv('SOLANA_RPC_URL');
  }

  private programId(): string {
    return this.requireEnv('SOLANA_HTLC_PROGRAM_ID');
  }

  private recipient(): string {
    return this.requireEnv('SOLANA_SWAP_RECIPIENT');
  }

  private requireEnv(key: string): string {
    const value = process.env[key];

    if (!value) {
      throw new Error(`Solana swaps are not configured; set ${key}`);
    }

    return value;
  }

  private u64(value: bigint): Buffer {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(value);
    return buffer;
  }

  private i64(value: bigint): Buffer {
    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64LE(value);
    return buffer;
  }

}

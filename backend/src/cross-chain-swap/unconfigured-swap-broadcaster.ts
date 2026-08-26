import { Injectable, Logger } from '@nestjs/common';
import { BroadcastResult, SwapBroadcaster } from './swap-broadcaster.interface';
import { UnsignedChainCall } from './chains/htlc-chain.adapter';

/**
 * Default `SwapBroadcaster` for deployments that have not wired up a signer.
 *
 * It fails loudly rather than silently dropping calls: an unbroadcast claim is
 * the difference between a settled swap and a refunded one, so the coordinator
 * needs to see the failure, record it, and retry once a signer exists.
 */
@Injectable()
export class UnconfiguredSwapBroadcaster implements SwapBroadcaster {
  private readonly logger = new Logger(UnconfiguredSwapBroadcaster.name);

  async broadcast(call: UnsignedChainCall): Promise<BroadcastResult> {
    this.logger.error(
      `No swap signer is configured; refusing to broadcast a ${call.chain} call to ${call.to}`,
    );

    throw new Error(
      `No SwapBroadcaster is configured for ${call.chain}. Provide one against the ` +
        'SWAP_BROADCASTER token to settle cross-chain swaps.',
    );
  }
}

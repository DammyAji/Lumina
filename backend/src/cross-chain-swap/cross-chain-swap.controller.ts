import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CrossChainSwapService } from './cross-chain-swap.service';
import { InitiateSwapDto } from './dto/initiate-swap.dto';

@Controller('api/swaps')
export class CrossChainSwapController {
  constructor(private readonly swaps: CrossChainSwapService) {}

  /**
   * Starts a swap and returns the lock request the customer must satisfy on the
   * source chain. Nothing is broadcast until they do.
   */
  @Post('initiate')
  initiate(@Body() dto: InitiateSwapDto) {
    return this.swaps.initiate(dto);
  }

  /** Networks this deployment accepts payments from. */
  @Get('supported-chains')
  supportedChains() {
    return this.swaps.supportedChains();
  }

  @Get(':id')
  getSwap(@Param('id') swapId: string) {
    return this.swaps.findBySwapId(swapId);
  }

  /**
   * Requests a refund. Only accepted once the source timelock has expired; the
   * refund itself is broadcast by the refund worker.
   */
  @Post(':id/refund')
  refund(@Param('id') swapId: string) {
    return this.swaps.requestRefund(swapId);
  }
}

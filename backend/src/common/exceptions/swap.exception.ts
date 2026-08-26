import { HttpStatus } from '@nestjs/common';
import { AppException } from './app.exception';
import { ErrorCode } from './error-code.enum';

export class SwapException extends AppException {
  constructor(
    errorCode: ErrorCode,
    message: string,
    statusCode: HttpStatus = HttpStatus.BAD_REQUEST,
    details?: Record<string, unknown>,
  ) {
    super(errorCode, message, statusCode, details);
  }

  static notFound(swapId: string): SwapException {
    return new SwapException(
      ErrorCode.SWAP_NOT_FOUND,
      `Swap with ID ${swapId} not found`,
      HttpStatus.NOT_FOUND,
    );
  }

  static unsupportedChain(chain: string): SwapException {
    return new SwapException(
      ErrorCode.SWAP_CHAIN_UNSUPPORTED,
      `Chain ${chain} is not supported as a swap source`,
      HttpStatus.BAD_REQUEST,
      { chain },
    );
  }

  static chainNotConfigured(chain: string): SwapException {
    return new SwapException(
      ErrorCode.SWAP_CHAIN_UNSUPPORTED,
      `Chain ${chain} is supported but not configured on this deployment`,
      HttpStatus.SERVICE_UNAVAILABLE,
      { chain },
    );
  }

  static notRefundable(swapId: string, status: string): SwapException {
    return new SwapException(
      ErrorCode.SWAP_NOT_REFUNDABLE,
      `Swap ${swapId} cannot be refunded from status ${status}`,
      HttpStatus.CONFLICT,
      { swapId, status },
    );
  }

  static timelockNotExpired(swapId: string, timeout: string): SwapException {
    return new SwapException(
      ErrorCode.SWAP_TIMELOCK_NOT_EXPIRED,
      `Swap ${swapId} cannot be refunded before its timelock at ${timeout}`,
      HttpStatus.CONFLICT,
      { swapId, timeout },
    );
  }

  static hashlockMismatch(swapId: string): SwapException {
    return new SwapException(
      ErrorCode.SWAP_HASHLOCK_MISMATCH,
      `On-chain hashlock for swap ${swapId} does not match the recorded secret hash`,
      HttpStatus.CONFLICT,
      { swapId },
    );
  }

  static amountMismatch(swapId: string, expected: string, actual: string): SwapException {
    return new SwapException(
      ErrorCode.SWAP_AMOUNT_MISMATCH,
      `Swap ${swapId} was funded with ${actual}, expected ${expected}`,
      HttpStatus.CONFLICT,
      { swapId, expected, actual },
    );
  }
}

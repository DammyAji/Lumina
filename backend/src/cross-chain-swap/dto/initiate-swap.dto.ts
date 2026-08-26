import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { SwapChain } from '../chains/chain.enum';

export class InitiateSwapDto {
  /** Network the customer is paying from. Stellar is the target, never a source. */
  @IsEnum(SwapChain)
  source_chain: SwapChain;

  /**
   * Address the customer funds from. On Bitcoin this is the customer's public
   * key, since the refund branch of the script pays back to a key, not an address.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  source_address: string;

  /** Merchant's Stellar account, paid in USDC. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  target_address: string;

  /** Decimal amount of `source_asset`, as a string to avoid float rounding. */
  @Matches(/^\d+(\.\d+)?$/, { message: 'amount must be a positive decimal string' })
  amount: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  source_asset: string;

  /** Payment this swap settles, when the swap is started from a payment. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  payment_id?: string;
}

import { Test, TestingModule } from '@nestjs/testing';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CrossChainSwapController } from './cross-chain-swap.controller';
import { CrossChainSwapService } from './cross-chain-swap.service';
import { InitiateSwapDto } from './dto/initiate-swap.dto';
import { SwapChain } from './chains/chain.enum';

const VALID_BODY = {
  source_chain: SwapChain.ETHEREUM,
  source_address: '0xcustomer',
  target_address: 'GMERCHANT',
  amount: '1.5',
  source_asset: 'ETH',
};

describe('CrossChainSwapController', () => {
  let controller: CrossChainSwapController;
  let swaps: Record<string, jest.Mock>;

  beforeEach(async () => {
    swaps = {
      initiate: jest.fn().mockResolvedValue({ swap: { swap_id: 'abc' }, lockRequest: {} }),
      supportedChains: jest.fn().mockReturnValue([{ chain: SwapChain.ETHEREUM }]),
      findBySwapId: jest.fn().mockResolvedValue({ swap_id: 'abc' }),
      requestRefund: jest.fn().mockResolvedValue({ swap_id: 'abc' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CrossChainSwapController],
      providers: [{ provide: CrossChainSwapService, useValue: swaps }],
    }).compile();

    controller = module.get(CrossChainSwapController);
  });

  describe('POST /api/swaps/initiate', () => {
    it('passes the body through and returns the lock request', async () => {
      const result = await controller.initiate(VALID_BODY as InitiateSwapDto);

      expect(swaps.initiate).toHaveBeenCalledWith(VALID_BODY);
      expect(result).toHaveProperty('lockRequest');
    });
  });

  describe('GET /api/swaps/supported-chains', () => {
    it('returns the configured source chains', () => {
      expect(controller.supportedChains()).toEqual([{ chain: SwapChain.ETHEREUM }]);
    });
  });

  describe('GET /api/swaps/:id', () => {
    it('looks the swap up by its swap id', async () => {
      await controller.getSwap('abc');

      expect(swaps.findBySwapId).toHaveBeenCalledWith('abc');
    });
  });

  describe('POST /api/swaps/:id/refund', () => {
    it('delegates to the coordinator', async () => {
      await controller.refund('abc');

      expect(swaps.requestRefund).toHaveBeenCalledWith('abc');
    });
  });
});

describe('InitiateSwapDto', () => {
  async function errorsFor(body: Record<string, unknown>) {
    return validate(plainToInstance(InitiateSwapDto, body));
  }

  it('accepts a well-formed body', async () => {
    expect(await errorsFor(VALID_BODY)).toHaveLength(0);
  });

  it('rejects a chain outside the supported set', async () => {
    const errors = await errorsFor({ ...VALID_BODY, source_chain: 'dogecoin' });

    expect(errors.map((error) => error.property)).toContain('source_chain');
  });

  it('rejects an amount that is not a positive decimal string', async () => {
    for (const amount of ['', 'abc', '-1', '1.2.3', '1e18']) {
      const errors = await errorsFor({ ...VALID_BODY, amount });

      expect(errors.map((error) => error.property)).toContain('amount');
    }
  });

  it('accepts a whole-number amount', async () => {
    expect(await errorsFor({ ...VALID_BODY, amount: '2' })).toHaveLength(0);
  });

  it('rejects an empty address', async () => {
    const errors = await errorsFor({ ...VALID_BODY, target_address: '' });

    expect(errors.map((error) => error.property)).toContain('target_address');
  });

  it('rejects an over-long address', async () => {
    const errors = await errorsFor({ ...VALID_BODY, source_address: 'x'.repeat(256) });

    expect(errors.map((error) => error.property)).toContain('source_address');
  });

  it('treats payment_id as optional', async () => {
    expect(await errorsFor({ ...VALID_BODY, payment_id: 'pay_1' })).toHaveLength(0);
  });
});

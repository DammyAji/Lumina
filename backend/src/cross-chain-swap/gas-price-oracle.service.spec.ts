import { GasPriceOracleService } from './gas-price-oracle.service';
import { SwapChain } from './chains/chain.enum';

describe('GasPriceOracleService', () => {
  let ethereum: { getGasPrice: jest.Mock };
  let polygon: { getGasPrice: jest.Mock };
  let bitcoin: { getFeeRate: jest.Mock };
  let solana: { getPriorityFee: jest.Mock };
  let service: GasPriceOracleService;

  beforeEach(() => {
    ethereum = { getGasPrice: jest.fn().mockResolvedValue(20_000_000_000n) };
    polygon = { getGasPrice: jest.fn().mockResolvedValue(30_000_000_000n) };
    bitcoin = { getFeeRate: jest.fn().mockResolvedValue(12.4) };
    solana = { getPriorityFee: jest.fn().mockResolvedValue(500n) };

    service = new GasPriceOracleService(
      ethereum as any,
      polygon as any,
      bitcoin as any,
      solana as any,
    );
  });

  afterEach(() => {
    delete process.env.ETHEREUM_MAX_GAS_PRICE;
  });

  it('quotes each chain in its own fee unit', async () => {
    await expect(service.getQuote(SwapChain.ETHEREUM)).resolves.toMatchObject({
      price: '20000000000',
      unit: 'wei_per_gas',
    });
    await expect(service.getQuote(SwapChain.POLYGON)).resolves.toMatchObject({
      unit: 'wei_per_gas',
    });
    await expect(service.getQuote(SwapChain.SOLANA)).resolves.toMatchObject({
      price: '500',
      unit: 'micro_lamports_per_cu',
    });
  });

  it('rounds a fractional Bitcoin fee rate up to a whole sat/vB', async () => {
    await expect(service.getQuote(SwapChain.BITCOIN)).resolves.toMatchObject({
      price: '13',
      unit: 'sat_per_vbyte',
    });
  });

  it('quotes Stellar without an RPC call, since its fee is flat', async () => {
    const quote = await service.getQuote(SwapChain.STELLAR);

    expect(quote.unit).toEqual('stroops_per_operation');
    expect(ethereum.getGasPrice).not.toHaveBeenCalled();
  });

  it('caches a quote instead of re-querying on every check', async () => {
    await service.getQuote(SwapChain.ETHEREUM);
    await service.getQuote(SwapChain.ETHEREUM);

    expect(ethereum.getGasPrice).toHaveBeenCalledTimes(1);
  });

  describe('ceilings', () => {
    it('is not above the ceiling when none is configured', async () => {
      await expect(service.getQuote(SwapChain.ETHEREUM)).resolves.toMatchObject({
        aboveCeiling: false,
      });
    });

    it('flags a quote above the configured ceiling', async () => {
      process.env.ETHEREUM_MAX_GAS_PRICE = '10000000000';

      await expect(service.getQuote(SwapChain.ETHEREUM)).resolves.toMatchObject({
        aboveCeiling: true,
      });
    });

    it('does not flag a quote exactly at the ceiling', async () => {
      process.env.ETHEREUM_MAX_GAS_PRICE = '20000000000';

      await expect(service.getQuote(SwapChain.ETHEREUM)).resolves.toMatchObject({
        aboveCeiling: false,
      });
    });
  });

  describe('shouldDefer', () => {
    it('defers a discretionary broadcast when gas is above the ceiling', async () => {
      process.env.ETHEREUM_MAX_GAS_PRICE = '1';

      await expect(service.shouldDefer(SwapChain.ETHEREUM)).resolves.toBe(true);
    });

    it('never stalls a swap just because the quote failed', async () => {
      ethereum.getGasPrice.mockRejectedValue(new Error('rpc down'));

      await expect(service.shouldDefer(SwapChain.ETHEREUM)).resolves.toBe(false);
    });
  });
});

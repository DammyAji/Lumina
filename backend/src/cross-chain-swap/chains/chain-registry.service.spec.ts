import { ChainRegistryService } from './chain-registry.service';
import { SwapChain } from './chain.enum';
import { HtlcChainAdapter } from './htlc-chain.adapter';
import { SwapException } from '../../common/exceptions';

function stubAdapter(chain: SwapChain, configured: boolean): HtlcChainAdapter {
  return { chain, isConfigured: () => configured } as HtlcChainAdapter;
}

function registry(configured: SwapChain[]) {
  return new ChainRegistryService(
    stubAdapter(SwapChain.ETHEREUM, configured.includes(SwapChain.ETHEREUM)) as any,
    stubAdapter(SwapChain.POLYGON, configured.includes(SwapChain.POLYGON)) as any,
    stubAdapter(SwapChain.BITCOIN, configured.includes(SwapChain.BITCOIN)) as any,
    stubAdapter(SwapChain.SOLANA, configured.includes(SwapChain.SOLANA)) as any,
    stubAdapter(SwapChain.STELLAR, configured.includes(SwapChain.STELLAR)) as any,
  );
}

describe('ChainRegistryService', () => {
  it('resolves each chain to its own adapter', () => {
    const service = registry([]);

    for (const chain of Object.values(SwapChain)) {
      expect(service.get(chain).chain).toEqual(chain);
    }
  });

  it('rejects a chain it has no adapter for', () => {
    expect(() => registry([]).get('dogecoin' as SwapChain)).toThrow(SwapException);
  });

  it('lists only the chains whose configuration is complete', () => {
    const service = registry([SwapChain.ETHEREUM, SwapChain.STELLAR]);

    expect(service.configuredChains().sort()).toEqual(
      [SwapChain.ETHEREUM, SwapChain.STELLAR].sort(),
    );
  });

  it('reports an unknown chain as unconfigured rather than throwing', () => {
    expect(registry([]).isConfigured('dogecoin' as SwapChain)).toBe(false);
  });
});

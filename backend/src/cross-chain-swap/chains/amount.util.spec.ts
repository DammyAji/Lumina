import { fromSmallestUnit, toSmallestUnit } from './amount.util';
import { SwapChain } from './chain.enum';

describe('toSmallestUnit', () => {
  it('scales by the chain decimals', () => {
    expect(toSmallestUnit('1', SwapChain.ETHEREUM)).toEqual(10n ** 18n);
    expect(toSmallestUnit('1', SwapChain.BITCOIN)).toEqual(100_000_000n);
    expect(toSmallestUnit('1', SwapChain.SOLANA)).toEqual(1_000_000_000n);
    expect(toSmallestUnit('1', SwapChain.STELLAR)).toEqual(10_000_000n);
  });

  it('keeps full precision on an 18-decimal amount a float would round', () => {
    expect(toSmallestUnit('0.123456789012345678', SwapChain.ETHEREUM)).toEqual(
      123_456_789_012_345_678n,
    );
  });

  it('pads a short fraction', () => {
    expect(toSmallestUnit('1.5', SwapChain.BITCOIN)).toEqual(150_000_000n);
  });

  it('truncates a fraction longer than the chain supports', () => {
    expect(toSmallestUnit('1.123456789', SwapChain.BITCOIN)).toEqual(112_345_678n);
  });

  it('handles a whole number with no fraction', () => {
    expect(toSmallestUnit('42', SwapChain.STELLAR)).toEqual(420_000_000n);
  });

  it('rejects a malformed amount', () => {
    expect(() => toSmallestUnit('abc', SwapChain.ETHEREUM)).toThrow(/not a valid decimal/);
    expect(() => toSmallestUnit('1.2.3', SwapChain.ETHEREUM)).toThrow(/not a valid decimal/);
    expect(() => toSmallestUnit('-1', SwapChain.ETHEREUM)).toThrow(/not a valid decimal/);
  });
});

describe('fromSmallestUnit', () => {
  it('inverts toSmallestUnit', () => {
    for (const amount of ['1', '0.5', '1234.56789']) {
      expect(fromSmallestUnit(toSmallestUnit(amount, SwapChain.BITCOIN), SwapChain.BITCOIN)).toEqual(
        amount,
      );
    }
  });

  it('trims trailing zeros', () => {
    expect(fromSmallestUnit(150_000_000n, SwapChain.BITCOIN)).toEqual('1.5');
  });

  it('renders sub-unit amounts with a leading zero', () => {
    expect(fromSmallestUnit(1n, SwapChain.BITCOIN)).toEqual('0.00000001');
  });

  it('renders a whole amount without a decimal point', () => {
    expect(fromSmallestUnit(10n ** 18n, SwapChain.ETHEREUM)).toEqual('1');
  });

  it('renders zero', () => {
    expect(fromSmallestUnit(0n, SwapChain.ETHEREUM)).toEqual('0');
  });
});

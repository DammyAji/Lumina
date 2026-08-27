import { encodeAddress, encodeCall, encodeWord, readAddress, readBytes32, readUint } from './abi.util';

describe('encodeWord', () => {
  it('left-pads hex to a full word', () => {
    expect(encodeWord('0xab')).toEqual(`${'0'.repeat(62)}ab`);
  });

  it('encodes numbers and bigints as hex', () => {
    expect(encodeWord(255)).toEqual(`${'0'.repeat(62)}ff`);
    expect(encodeWord(10n ** 18n)).toEqual('0de0b6b3a7640000'.padStart(64, '0'));
  });

  it('lowercases hex so checksummed addresses encode identically', () => {
    expect(encodeWord('0xAB')).toEqual(encodeWord('0xab'));
  });
});

describe('encodeAddress', () => {
  it('left-pads a 20-byte address into a word', () => {
    const encoded = encodeAddress('0x1111111111111111111111111111111111111111');

    expect(encoded).toEqual(`${'0'.repeat(24)}${'11'.repeat(20)}`);
  });
});

describe('encodeCall', () => {
  it('concatenates the selector with each padded argument', () => {
    const data = encodeCall('0x84cc9dfb', [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`]);

    expect(data).toEqual(`0x84cc9dfb${'aa'.repeat(32)}${'bb'.repeat(32)}`);
  });

  it('accepts a selector without a 0x prefix', () => {
    expect(encodeCall('7249fbb6', [`0x${'cc'.repeat(32)}`])).toEqual(
      `0x7249fbb6${'cc'.repeat(32)}`,
    );
  });
});

describe('decoding', () => {
  const response = `0x${encodeWord('0x' + '11'.repeat(20))}${encodeWord(1234n)}${'ee'.repeat(32)}`;

  it('reads an address from its word', () => {
    expect(readAddress(response, 0)).toEqual(`0x${'11'.repeat(20)}`);
  });

  it('reads a uint from its word', () => {
    expect(readUint(response, 1)).toEqual(1234n);
  });

  it('reads a bytes32 from its word', () => {
    expect(readBytes32(response, 2)).toEqual('ee'.repeat(32));
  });

  it('rejects a response that is too short for the requested word', () => {
    expect(() => readUint(response, 9)).toThrow(/too short/);
  });
});

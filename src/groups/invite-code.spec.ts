import { newInviteCode } from './invite-code';

// Bytes handed out in turn, to check what the function does with chosen ones.
const feed = (bytes: number[]) => {
  let at = 0;
  return (size: number) =>
    Buffer.from(Array.from({ length: size }, () => bytes[at++ % bytes.length]));
};

describe('newInviteCode', () => {
  it('is always six digits', () => {
    for (let i = 0; i < 2000; i++)
      expect(newInviteCode()).toMatch(/^[0-9]{6}$/);
  });

  it('takes the last digit of each byte, in order', () => {
    expect(newInviteCode(feed([11, 22, 33, 44, 55, 66]))).toBe('123456');
    expect(newInviteCode(feed([0, 9, 10, 19, 100, 249]))).toBe('090909');
  });

  it('throws away the bytes from 250 up, which would favour the low digits', () => {
    // 250..255 would give 0..5 once more than 6..9: they must not be used.
    expect(
      newInviteCode(feed([250, 251, 252, 253, 254, 255, 7, 7, 7, 7, 7, 7])),
    ).toBe('777777');
  });

  it('asks for more bytes when a draw ran out of usable ones', () => {
    // 16 bytes per draw, all unusable in the first.
    const bytes = [
      ...new Array<number>(16).fill(255),
      1,
      2,
      3,
      4,
      5,
      6,
      ...new Array<number>(10).fill(255),
    ];
    expect(newInviteCode(feed(bytes))).toBe('123456');
  });

  it('gives every digit about equally often', () => {
    const seen = new Array<number>(10).fill(0);
    for (let i = 0; i < 10_000; i++)
      for (const d of newInviteCode()) seen[Number(d)]++;
    // 60 000 digits, 6000 each; a 10 % band is dozens of standard deviations wide.
    for (const n of seen) expect(Math.abs(n - 6000)).toBeLessThan(600);
  });

  it('keeps leading zeros', () => {
    expect(newInviteCode(feed([0, 0, 0, 0, 0, 1]))).toBe('000001');
  });
});

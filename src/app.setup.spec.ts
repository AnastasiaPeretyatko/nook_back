import { assertShallowJson, MAX_JSON_DEPTH } from './app.setup';

const check = (text: string) => () => assertShallowJson(Buffer.from(text));
const nest = (depth: number) => '['.repeat(depth) + ']'.repeat(depth);

describe('assertShallowJson', () => {
  it('lets through exactly the maximum depth and refuses one more', () => {
    expect(check(nest(MAX_JSON_DEPTH))).not.toThrow();
    expect(check(nest(MAX_JSON_DEPTH + 1))).toThrow('nested too deeply');
  });

  it('counts objects and arrays together', () => {
    const mixed = '{"a":['.repeat(MAX_JSON_DEPTH / 2 + 1);
    expect(check(mixed)).toThrow();
  });

  it('ignores brackets inside strings, even after an escaped quote', () => {
    const brackets = '['.repeat(100);
    expect(check(`{"a":"${brackets}"}`)).not.toThrow();
    expect(check(`{"a":"x\\"${brackets}"}`)).not.toThrow();
    // an escaped backslash does not escape the closing quote
    expect(check(`{"a":"\\\\","b":[${nest(MAX_JSON_DEPTH)}]}`)).toThrow();
  });

  it('refuses with status 400', () => {
    try {
      assertShallowJson(Buffer.from(nest(MAX_JSON_DEPTH + 1)));
      fail('should have thrown');
    } catch (error) {
      expect((error as { status: number }).status).toBe(400);
    }
  });
});

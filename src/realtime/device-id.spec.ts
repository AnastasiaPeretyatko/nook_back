import { parseDeviceId } from './device-id';

describe('parseDeviceId', () => {
  it.each([
    'a',
    'phone-1',
    'A_b-9',
    'x'.repeat(64),
    '550e8400-e29b-41d4-a716-446655440000',
  ])('accepts %s', (value) => expect(parseDeviceId(value)).toBe(value));

  it.each([
    ['empty', ''],
    ['65 characters', 'x'.repeat(65)],
    ['a space', 'phone 1'],
    ['a dot', 'a.b'],
    ['a newline', 'ab\n'],
    ['non-latin letters', 'телефон'],
    ['undefined', undefined],
    ['null', null],
    ['a number', 5],
    ['a list (header sent twice)', ['a', 'b']],
  ])('treats %s as no device', (_name, value) =>
    expect(parseDeviceId(value)).toBeUndefined(),
  );
});

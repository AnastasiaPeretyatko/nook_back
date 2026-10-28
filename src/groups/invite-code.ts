import { randomBytes } from 'crypto';

const LENGTH = 6;

// Six digits, each equally likely. A random byte is 0-255 and 256 is not a multiple of 10, so
// the bytes from 250 up are thrown away; of the rest, the last digit is taken (the same
// bargain as the Supabase function this ports, `reference/sql/006`). `random` is a parameter
// only so that a test can feed it chosen bytes.
export function newInviteCode(random: (size: number) => Buffer = randomBytes) {
  let code = '';
  while (code.length < LENGTH) {
    for (const byte of random(16)) {
      if (byte < 250 && code.length < LENGTH) code += byte % 10;
    }
  }
  return code;
}

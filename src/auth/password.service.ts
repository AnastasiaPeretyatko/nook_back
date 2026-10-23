import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

// OWASP-recommended argon2id parameters (19 MiB, 2 passes, 1 lane).
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return argon2.hash(password, OPTIONS);
  }

  // Always does a full argon2 check, even when there is no hash to compare with
  // (unknown email, Google-only account), so the response time does not reveal
  // whether the account exists.
  async verify(hash: string | null | undefined, password: string) {
    this.dummyHash ??= this.hash('dummy-password-for-timing');
    try {
      const matches = await argon2.verify(
        hash ?? (await this.dummyHash),
        password,
      );
      return hash != null && matches;
    } catch {
      return false; // a malformed stored hash is "no match", not a server error
    }
  }
}

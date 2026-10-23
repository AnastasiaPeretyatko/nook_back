import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with the planned argon2id parameters', async () => {
    const hash = await service.hash('correct horse');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,/);
    expect(hash).toContain('t=2');
    expect(hash).toContain('p=1');
  });

  it('salts: the same password gives different hashes', async () => {
    expect(await service.hash('same')).not.toBe(await service.hash('same'));
  });

  it('accepts the right password and rejects a wrong one', async () => {
    const hash = await service.hash('correct horse');
    expect(await service.verify(hash, 'correct horse')).toBe(true);
    expect(await service.verify(hash, 'correct horse ')).toBe(false);
    expect(await service.verify(hash, '')).toBe(false);
  });

  it('never matches when there is no hash, but still spends the time of a real check', async () => {
    await service.verify(null, 'warm-up'); // the first call also prepares the dummy hash
    const started = Date.now();
    expect(await service.verify(null, 'anything')).toBe(false);
    expect(await service.verify(undefined, 'dummy-password-for-timing')).toBe(
      false,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(10); // two argon2 runs
  });

  it('treats a malformed stored hash as no match', async () => {
    expect(await service.verify('not-a-hash', 'x')).toBe(false);
  });
});

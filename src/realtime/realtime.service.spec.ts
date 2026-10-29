import { Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { RealtimeService } from './realtime.service';

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closedWith?: number;
  fail?: 'throw' | 'callback';
  // Like `ws`, a failure is reported to the callback later, outside the call to send.
  late?: () => void;
  send = jest.fn((message: string, done?: (error?: Error) => void) => {
    if (this.fail === 'throw') throw new Error('socket is not open');
    if (this.fail === 'callback') {
      this.late = () => done?.(new Error('broken pipe'));
      return;
    }
    this.sent.push(message);
    done?.();
  });
  close = jest.fn((code: number) => {
    this.closedWith = code;
  });
}

describe('RealtimeService', () => {
  const FAR = Date.now() + 3_600_000;
  let service: RealtimeService;
  let warn: jest.SpyInstance;

  const join = (
    userId: string,
    options: { deviceId?: string; expiresAt?: number } = {},
  ) => {
    const socket = new FakeSocket();
    service.add(userId, socket as unknown as WebSocket, {
      expiresAt: FAR,
      ...options,
    });
    return socket;
  };

  beforeEach(() => {
    service = new RealtimeService();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('ring', () => {
    it('sends a bare "changed" to every connection of the named user, and only to them', () => {
      const phone = join('ann', { deviceId: 'phone' });
      const tablet = join('ann', { deviceId: 'tablet' });
      const bob = join('bob');
      service.ring(['ann']);
      expect(phone.sent).toEqual(['{"t":"changed"}']);
      expect(tablet.sent).toEqual(['{"t":"changed"}']);
      expect(bob.sent).toEqual([]);
    });

    it("skips the connection of the device that wrote, but not the same person's other device", () => {
      const phone = join('ann', { deviceId: 'phone' });
      const tablet = join('ann', { deviceId: 'tablet' });
      service.ring(['ann'], 'phone');
      expect(phone.sent).toEqual([]);
      expect(tablet.sent).toHaveLength(1);
    });

    it('skips that device for every user (the id is a name, not an owner)', () => {
      const anns = join('ann', { deviceId: 'phone' });
      const bobs = join('bob', { deviceId: 'phone' });
      service.ring(['ann', 'bob'], 'phone');
      expect([anns.sent, bobs.sent]).toEqual([[], []]);
    });

    it('rings connections that did not name themselves, whatever the writer is called', () => {
      const nameless = join('ann');
      service.ring(['ann'], 'phone');
      expect(nameless.sent).toHaveLength(1);
    });

    it('rings everyone when the writer has no device id', () => {
      const phone = join('ann', { deviceId: 'phone' });
      service.ring(['ann']);
      expect(phone.sent).toHaveLength(1);
    });

    it('sends once per connection even if a user is listed twice', () => {
      const phone = join('ann');
      service.ring(['ann', 'ann']);
      expect(phone.sent).toHaveLength(1);
    });

    it('accepts any iterable, an empty list, and users nobody has connected', () => {
      const phone = join('ann');
      service.ring([]);
      service.ring(['nobody']);
      service.ring(new Set(['ann']));
      expect(phone.sent).toHaveLength(1);
    });

    it('does not ring a connection that has closed', () => {
      const phone = join('ann');
      phone.emit('close');
      service.ring(['ann']);
      expect(phone.sent).toEqual([]);
      expect(service.count('ann')).toBe(0);
    });

    it.each(['throw', 'callback'] as const)(
      'a connection whose send fails (%s) does not stop the others or throw',
      (how) => {
        const broken = join('ann');
        broken.fail = how;
        const fine = join('ann');
        const other = join('bob');
        expect(() => service.ring(['ann', 'bob'])).not.toThrow();
        expect(fine.sent).toHaveLength(1);
        expect(other.sent).toHaveLength(1);
        expect(() => broken.late?.()).not.toThrow();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('Send failed'),
        );
      },
    );
  });

  describe('an expired token', () => {
    it('closes the connection with 4401 instead of ringing it, and forgets it', () => {
      const old = join('ann', { expiresAt: Date.now() - 1 });
      const fresh = join('ann');
      service.ring(['ann']);
      expect(old.closedWith).toBe(4401);
      expect(old.sent).toEqual([]);
      expect(fresh.sent).toHaveLength(1);
      expect(fresh.closedWith).toBeUndefined();
      expect(service.count('ann')).toBe(1);
    });

    it('counts the very second of expiry as expired', () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const socket = join('ann', { expiresAt: 1_000_000 });
      service.ring(['ann']);
      expect(socket.closedWith).toBe(4401);
    });

    it('leaves the device that wrote alone: it is not rung, so there is nothing to refuse', () => {
      const phone = join('ann', {
        deviceId: 'phone',
        expiresAt: Date.now() - 1,
      });
      service.ring(['ann'], 'phone');
      expect(phone.closedWith).toBeUndefined(); // skipped before any check: it is not rung
    });

    it('answers ping with pong while the token lives', () => {
      const socket = join('ann');
      service.pong('ann', socket as unknown as WebSocket);
      expect(socket.sent).toEqual(['{"t":"pong"}']);
    });

    it('answers ping with 4401 and no pong once the token has run out', () => {
      const socket = join('ann', { expiresAt: Date.now() + 50 });
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 100);
      service.pong('ann', socket as unknown as WebSocket);
      expect(socket.sent).toEqual([]);
      expect(socket.closedWith).toBe(4401);
      expect(service.count('ann')).toBe(0);
    });

    it('a close that throws does not escape', () => {
      const socket = join('ann', { expiresAt: Date.now() - 1 });
      socket.close.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(() => service.ring(['ann'])).not.toThrow();
    });

    it('ignores a ping from a socket it does not know', () => {
      const stranger = new FakeSocket();
      service.pong('ann', stranger as unknown as WebSocket);
      expect(stranger.sent).toEqual([]);
    });
  });
});

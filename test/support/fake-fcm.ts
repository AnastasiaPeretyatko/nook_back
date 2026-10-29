import { PushMessage, PushOutcome } from '../../src/push/push-sender';

// The FCM sender, replaced in tests: records what would have been sent and answers as told. Never
// touches the network. Give it to the app with
//   createTestApp([], 0, (b) => b.overrideProvider(PushSender).useValue(fcm))
export class FakeFcm {
  enabled = true;
  sent: { token: string; message: PushMessage }[] = [];
  // What to answer for a token; anything else is 'sent'.
  outcomes = new Map<string, PushOutcome>();
  // Everything throws (FCM is down).
  fail = false;
  // Sends wait for this to open (Google is slow).
  gate?: Promise<void>;
  // How long each send takes, and how many were under way at once at most.
  delayMs = 0;
  inflight = 0;
  maxInflight = 0;

  reset() {
    this.enabled = true;
    this.sent = [];
    this.outcomes.clear();
    this.fail = false;
    this.gate = undefined;
    this.delayMs = 0;
    this.inflight = 0;
    this.maxInflight = 0;
  }

  async send(to: string, message: PushMessage): Promise<PushOutcome> {
    if (this.fail) throw new Error('FCM is down');
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      await this.gate;
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      this.sent.push({ token: to, message });
      return this.outcomes.get(to) ?? 'sent';
    } finally {
      this.inflight -= 1;
    }
  }
}

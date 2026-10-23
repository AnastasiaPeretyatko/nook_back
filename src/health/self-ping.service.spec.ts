import { ConfigService } from '@nestjs/config';
import { SelfPingService } from './self-ping.service';

const FIVE_MIN = 5 * 60 * 1000;

function makeService(url?: string) {
  const config = { get: () => url } as unknown as ConfigService<any, true>;
  return new SelfPingService(config);
}

describe('SelfPingService', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;
  });

  afterEach(() => jest.useRealTimers());

  it('does nothing when SELF_PING_URL is not set', async () => {
    const service = makeService(undefined);
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(FIVE_MIN * 3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls /health of the given address every 5 minutes', async () => {
    const service = makeService('https://nook.onrender.com/');
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(FIVE_MIN * 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [calledUrl] = fetchMock.mock.calls[0] as [string];
    expect(calledUrl).toBe('https://nook.onrender.com/health');
    service.onModuleDestroy();
  });

  it('survives a failed ping and keeps going', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const service = makeService('https://nook.onrender.com');
    service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(FIVE_MIN * 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });

  it('stops pinging after shutdown', async () => {
    const service = makeService('https://nook.onrender.com');
    service.onApplicationBootstrap();
    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(FIVE_MIN * 3);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

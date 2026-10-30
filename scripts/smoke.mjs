// A quick check that a running server works end to end: sign-up, /me, the socket (ping/pong), a
// "ring" caused by a write from another phone, pull, and deleting the test account again.
//
//   node scripts/smoke.mjs [server address]        (default: http://localhost:3000)
//
// It creates one account with a made-up address and deletes it at the end (the empty shell of the
// row stays, as for any deleted account). Run from the project folder (it uses the `ws` package).
import WebSocket from 'ws';

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const email = `smoke-${Date.now()}@example.com`;
const password = 'correct horse smoke';
let token;

async function api(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body && { 'content-type': 'application/json' }),
      ...(token && { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(90_000), // a sleeping database needs a while to wake
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function step(name, run) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exit(1);
  }
}
const expect = (condition, what) => {
  if (!condition) throw new Error(what);
};

const messages = [];
const waitFor = async (text, ms = 5000) => {
  for (let waited = 0; waited < ms; waited += 50) {
    if (messages.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `no ${text} within ${ms / 1000} s (got: ${messages.join(' ') || 'nothing'})`,
  );
};

await step('the server answers /health', async () => {
  const res = await api('GET', '/health');
  expect(res.status === 200 && res.body.ok === true, `HTTP ${res.status}`);
});

await step('sign up', async () => {
  const res = await api('POST', '/auth/register', { email, password });
  expect(res.status === 201, `HTTP ${res.status} ${JSON.stringify(res.body)}`);
  token = res.body.accessToken;
});

await step('/me is the new account', async () => {
  const res = await api('GET', '/me');
  expect(res.status === 200 && res.body.email === email, `HTTP ${res.status}`);
});

let socket;
await step('the socket opens and answers ping with pong', async () => {
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = `?token=${token}&device=smoke-a`;
  socket = new WebSocket(url);
  socket.on('message', (raw) => messages.push(raw.toString()));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send('{"t":"ping"}');
  await waitFor('{"t":"pong"}');
});

await step('a write from another phone rings this one', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const res = await api(
    'POST',
    '/sync/push',
    { tasks: [{ id, title: 'smoke' }] },
    { 'x-device-id': 'smoke-b' },
  );
  expect(
    res.status === 200 && res.body.rejected.length === 0,
    `HTTP ${res.status} ${JSON.stringify(res.body)}`,
  );
  await waitFor('{"t":"changed"}');
});

await step('pull returns the task', async () => {
  const res = await api('GET', '/sync/pull');
  expect(
    res.status === 200 && res.body.tasks.some((t) => t.title === 'smoke'),
    `HTTP ${res.status}`,
  );
});

socket.close();
await step('delete the test account', async () => {
  const res = await api('DELETE', '/me', { password });
  expect(res.status === 204, `HTTP ${res.status} ${JSON.stringify(res.body)}`);
  expect(
    (await api('POST', '/auth/login', { email, password })).status === 401,
    'the account can still sign in',
  );
});

console.log('All good.');

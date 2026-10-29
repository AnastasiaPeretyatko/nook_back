export interface FirebaseServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const PROBLEM =
  'must be the service account key file (JSON) encoded as base64: base64 -w0 key.json';

// The value of FIREBASE_SERVICE_ACCOUNT. Throws a short reason on anything wrong; the reason never
// repeats the value (it holds a private key, and startup errors end up in logs).
export function parseServiceAccount(value: string): FirebaseServiceAccount {
  const text = value.trim();
  if (text.startsWith('{')) {
    throw new Error(`the JSON itself was given, but it ${PROBLEM}`);
  }
  let key: Record<string, unknown>;
  try {
    key = JSON.parse(Buffer.from(text, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error(`is not base64 of a JSON file; it ${PROBLEM}`);
  }
  const { type, project_id, client_email, private_key } = key ?? {};
  if (
    type !== 'service_account' ||
    typeof project_id !== 'string' ||
    typeof client_email !== 'string' ||
    typeof private_key !== 'string' ||
    !project_id ||
    !client_email ||
    !private_key.includes('-----BEGIN')
  ) {
    throw new Error(
      'is not a service account key (it needs type, project_id, client_email, private_key)',
    );
  }
  return { project_id, client_email, private_key };
}

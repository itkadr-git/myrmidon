import https from 'node:https';
import { createHandler } from './http.mjs';
import { createRecoveredSingleHostBroker } from './broker.mjs';

// Recovery requires exclusive, quiesced access to the single-host stores.
export async function createRecoveredSecureServer(tls, options) {
  const broker = await createRecoveredSingleHostBroker(options);
  try {
    const server = createSecureServer(tls, broker);
    server.once('close', () => broker.close());
    return server;
  } catch (error) {
    broker.close();
    throw error;
  }
}

export function createSecureServer({ key, cert, ca }, broker) {
  if (!key || !cert || !ca) throw new Error('TLS key, certificate and client CA are required');
  return https.createServer({ key, cert, ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, createHandler(broker));
}

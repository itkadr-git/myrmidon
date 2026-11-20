import { createServer } from 'node:https';
import { createHandler } from './reader.mjs';

// TLS terminates here; never expose the underlying HTTP handler to the runner.
export function createListener({ tls, ...handlerOptions }) {
  if (!tls || !tls.key || !tls.cert) throw new TypeError('TLS certificate and key are required');
  return createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, createHandler(handlerOptions));
}

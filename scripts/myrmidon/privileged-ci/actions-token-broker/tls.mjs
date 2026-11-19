import https from 'node:https';
import { createHandler } from './http.mjs';

export function createSecureServer({ key, cert, ca }, broker) {
  if (!key || !cert || !ca) throw new Error('TLS key, certificate and client CA are required');
  return https.createServer({ key, cert, ca, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, createHandler(broker));
}

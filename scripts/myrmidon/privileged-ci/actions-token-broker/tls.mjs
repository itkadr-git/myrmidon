import https from 'node:https';
import { createHandler } from './http.mjs';
import { createRecoveredSingleHostBroker, createSupervisedSingleHostBroker } from './broker.mjs';
import { createAuthenticatedAudit, createAsyncAuthenticatedAudit } from './authenticated-audit.mjs';

// The anchor must be independently durable and outside the audit database's failure domain.
export async function createAuditedSupervisedServer(tls, { auditPath, auditKey, auditAnchor, ...options }) {
  if (!auditAnchor || typeof auditAnchor.read !== 'function' || typeof auditAnchor.compareAndSet !== 'function') throw new Error('audit anchor required');
  if (typeof options.alert !== 'function') throw new Error('recovery alert required');
  let audit;
  try {
    audit = await createAsyncAuthenticatedAudit(auditPath, auditKey, auditAnchor);
  } catch (error) {
    // Keep startup closed while retrying delivery; a process crash still requires external supervision.
    for (;;) {
      try { await options.alert('audit_unavailable'); break; } catch {
        if (typeof options.delay !== 'function') break;
        await options.delay();
      }
    }
    throw error;
  }
  let broker;
  try {
    broker = await createSupervisedSingleHostBroker({ ...options, audit: event => audit.record(event) });
    const server = createSecureServer(tls, broker);
    server.once('close', () => { try { broker.close(); } finally { audit.close(); } });
    return server;
  } catch (error) {
    try { broker?.close(); } finally { audit.close(); }
    throw error;
  }
}

// The anchor must be independently durable and outside the audit database's failure domain.
export async function createAuditedRecoveredServer(tls, { auditPath, auditKey, auditAnchor, ...options }) {
  if (!auditAnchor || typeof auditAnchor.read !== 'function' || typeof auditAnchor.compareAndSet !== 'function') throw new Error('audit anchor required');
  if (typeof options.alert !== 'function') throw new Error('recovery alert required');
  const audit = createAuthenticatedAudit(auditPath, auditKey, auditAnchor);
  try {
    const server = await createRecoveredSecureServer(tls, { ...options, audit: event => audit.record(event) });
    server.once('close', () => audit.close());
    return server;
  } catch (error) {
    audit.close();
    throw error;
  }
}

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

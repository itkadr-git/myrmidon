import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPersistentCredentialStore } from './persistent-credentials.mjs';
import { createListener } from './listener.mjs';
import { createUpstream } from './upstream.mjs';

// Configuration and private keys are supplied by the operator, never by a request.
export function start(config) {
  if (!config || typeof config.host !== 'string' || !config.host || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.credentialDirectory !== 'string' || !config.credentialDirectory || typeof config.auditFile !== 'string' || !config.auditFile) throw new TypeError('invalid listener configuration');
  const read = (file) => readFileSync(file);
  const credentialStore = createPersistentCredentialStore(config.credentialDirectory);
  const upstream = createUpstream({ origin: config.upstream.origin, ca: read(config.upstream.ca), cert: read(config.upstream.cert), key: read(config.upstream.key) });
  const server = createListener({
    tls: { cert: read(config.listener.cert), key: read(config.listener.key) },
    credentialStore,
    ...upstream,
    audit: async (event) => appendFileSync(config.auditFile, `${JSON.stringify(event)}\n`, { mode: 0o600 }),
  });
  server.listen(config.port, config.host);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('usage: node main.mjs /path/to/private-config.json');
  start(JSON.parse(readFileSync(process.argv[2], 'utf8')));
}

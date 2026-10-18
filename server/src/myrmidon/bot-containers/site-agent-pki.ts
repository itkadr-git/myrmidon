// server/src/myrmidon/bot-containers/site-agent-pki.ts
//
// myrmidon(1.6.6 T10-A): Ephemeral test PKI generation in scratch directory.
// Produces ephemeral CA, server certificate, valid client certificate,
// foreign (untrusted) CA/client certificate, and expired client certificate.
// All generated keys and certificates are temporary and used solely for
// negative mTLS regression testing without live Docker or production keys.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface TestPkiArtifacts {
  dir: string;
  caCert: string;
  caKey: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
  foreignCaCert: string;
  foreignCaKey: string;
  foreignClientCert: string;
  foreignClientKey: string;
  expiredClientCert: string;
  expiredClientKey: string;
}

/**
 * Resolves an allowed scratch directory under strict OPE-1524 hygiene rules:
 * Only explicit custom scratch dir, $PAPERCLIP_SCRATCH_DIR, $PAPERCLIP_RUN_SCRATCH_DIR,
 * or $HOME/.myrmidon-scratch are permitted. Fallback to shared system /tmp or
 * os.tmpdir() is strictly prohibited.
 */
export function resolveAllowedScratchDir(customScratchDir?: string): string {
  const candidate =
    customScratchDir ||
    process.env.PAPERCLIP_SCRATCH_DIR ||
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ||
    (process.env.HOME ? path.join(process.env.HOME, ".myrmidon-scratch") : undefined);

  if (!candidate || candidate.trim().length === 0) {
    throw new Error(
      "Ephemeral test PKI requires an allowed scratch directory ($PAPERCLIP_SCRATCH_DIR, $PAPERCLIP_RUN_SCRATCH_DIR, or $HOME/.myrmidon-scratch). Fallback to system /tmp or os.tmpdir() is prohibited by OPE-1524 hygiene rules.",
    );
  }
  return candidate;
}

/**
 * Generates an ephemeral test PKI environment in the specified or default scratch directory.
 * Never writes to shared system /tmp directly; uses run scratch or home scratch.
 */
export function generateEphemeralTestPki(customScratchDir?: string): TestPkiArtifacts {
  const baseScratch = resolveAllowedScratchDir(customScratchDir);

  const pkiDir = path.join(baseScratch, `pki-ephemeral-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(pkiDir, { recursive: true, mode: 0o700 });

  const runOpenssl = (args: string[], extFileContent?: string): void => {
    let extFilePath: string | undefined;
    const finalArgs = [...args];
    if (extFileContent) {
      extFilePath = path.join(pkiDir, `ext-${Math.random().toString(36).slice(2, 8)}.cnf`);
      fs.writeFileSync(extFilePath, extFileContent, { mode: 0o600 });
      finalArgs.push("-extfile", extFilePath);
    }
    try {
      execFileSync("openssl", finalArgs, {
        cwd: pkiDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } finally {
      if (extFilePath && fs.existsSync(extFilePath)) {
        fs.unlinkSync(extFilePath);
      }
    }
  };

  const caKeyPath = path.join(pkiDir, "site-ca.key");
  const caCertPath = path.join(pkiDir, "site-ca.crt");
  const serverKeyPath = path.join(pkiDir, "server.key");
  const serverCsrPath = path.join(pkiDir, "server.csr");
  const serverCertPath = path.join(pkiDir, "server.crt");
  const clientKeyPath = path.join(pkiDir, "client.key");
  const clientCsrPath = path.join(pkiDir, "client.csr");
  const clientCertPath = path.join(pkiDir, "client.crt");

  const foreignCaKeyPath = path.join(pkiDir, "foreign-ca.key");
  const foreignCaCertPath = path.join(pkiDir, "foreign-ca.crt");
  const foreignClientKeyPath = path.join(pkiDir, "foreign-client.key");
  const foreignClientCsrPath = path.join(pkiDir, "foreign-client.csr");
  const foreignClientCertPath = path.join(pkiDir, "foreign-client.crt");

  const expiredClientKeyPath = path.join(pkiDir, "expired-client.key");
  const expiredClientCsrPath = path.join(pkiDir, "expired-client.csr");
  const expiredClientCertPath = path.join(pkiDir, "expired-client.crt");

  // 1. Root site-ca
  runOpenssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKeyPath,
    "-out",
    caCertPath,
    "-days",
    "30",
    "-subj",
    "/CN=myrmidon-test-site-ca",
  ]);

  // 2. Server cert for localhost/127.0.0.1 signed by site-ca
  runOpenssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    serverKeyPath,
    "-out",
    serverCsrPath,
    "-subj",
    "/CN=127.0.0.1",
  ]);
  runOpenssl(
    [
      "x509",
      "-req",
      "-in",
      serverCsrPath,
      "-CA",
      caCertPath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-out",
      serverCertPath,
      "-days",
      "30",
    ],
    "subjectAltName=IP:127.0.0.1,DNS:localhost\n",
  );

  // 3. Valid client cert signed by site-ca
  runOpenssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    clientKeyPath,
    "-out",
    clientCsrPath,
    "-subj",
    "/CN=myrmidon-board-client-valid",
  ]);
  runOpenssl([
    "x509",
    "-req",
    "-in",
    clientCsrPath,
    "-CA",
    caCertPath,
    "-CAkey",
    caKeyPath,
    "-CAcreateserial",
    "-out",
    clientCertPath,
    "-days",
    "30",
  ]);

  // 4. Foreign CA & foreign client cert (NOT trusted by site-ca)
  runOpenssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    foreignCaKeyPath,
    "-out",
    foreignCaCertPath,
    "-days",
    "30",
    "-subj",
    "/CN=foreign-untrusted-ca",
  ]);
  runOpenssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    foreignClientKeyPath,
    "-out",
    foreignClientCsrPath,
    "-subj",
    "/CN=foreign-client",
  ]);
  runOpenssl([
    "x509",
    "-req",
    "-in",
    foreignClientCsrPath,
    "-CA",
    foreignCaCertPath,
    "-CAkey",
    foreignCaKeyPath,
    "-CAcreateserial",
    "-out",
    foreignClientCertPath,
    "-days",
    "30",
  ]);

  // 5. Expired client cert signed by site-ca (expired in 2020)
  // Uses `openssl ca` with -startdate and -enddate for universal compatibility across OpenSSL 1.1, 3.0, and 3.5.
  const indexTxtPath = path.join(pkiDir, "index.txt");
  const serialPath = path.join(pkiDir, "serial");
  const caCnfPath = path.join(pkiDir, "ca.cnf");

  fs.writeFileSync(indexTxtPath, "", { mode: 0o600 });
  fs.writeFileSync(serialPath, "01\n", { mode: 0o600 });

  const caCnfContent = `[ ca ]
default_ca = test_ca

[ test_ca ]
database = ${indexTxtPath}
serial = ${serialPath}
new_certs_dir = ${pkiDir}
certificate = ${caCertPath}
private_key = ${caKeyPath}
default_md = sha256
policy = policy_any

[ policy_any ]
commonName = supplied
`;
  fs.writeFileSync(caCnfPath, caCnfContent, { mode: 0o600 });

  runOpenssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    expiredClientKeyPath,
    "-out",
    expiredClientCsrPath,
    "-subj",
    "/CN=expired-client",
  ]);

  runOpenssl([
    "ca",
    "-config",
    caCnfPath,
    "-batch",
    "-in",
    expiredClientCsrPath,
    "-out",
    expiredClientCertPath,
    "-startdate",
    "20190101000000Z",
    "-enddate",
    "20200101000000Z",
  ]);

  return {
    dir: pkiDir,
    caCert: fs.readFileSync(caCertPath, "utf8"),
    caKey: fs.readFileSync(caKeyPath, "utf8"),
    serverCert: fs.readFileSync(serverCertPath, "utf8"),
    serverKey: fs.readFileSync(serverKeyPath, "utf8"),
    clientCert: fs.readFileSync(clientCertPath, "utf8"),
    clientKey: fs.readFileSync(clientKeyPath, "utf8"),
    foreignCaCert: fs.readFileSync(foreignCaCertPath, "utf8"),
    foreignCaKey: fs.readFileSync(foreignCaKeyPath, "utf8"),
    foreignClientCert: fs.readFileSync(foreignClientCertPath, "utf8"),
    foreignClientKey: fs.readFileSync(foreignClientKeyPath, "utf8"),
    expiredClientCert: fs.readFileSync(expiredClientCertPath, "utf8"),
    expiredClientKey: fs.readFileSync(expiredClientKeyPath, "utf8"),
  };
}

/**
 * Removes ephemeral PKI directory and files cleanly.
 */
export function cleanupTestPki(artifacts: TestPkiArtifacts): void {
  try {
    if (artifacts?.dir && fs.existsSync(artifacts.dir)) {
      fs.rmSync(artifacts.dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors in scratch
  }
}

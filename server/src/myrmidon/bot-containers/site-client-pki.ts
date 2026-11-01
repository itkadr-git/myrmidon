import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
const DAY_MS = 86_400_000;
export const SITE_CLIENT_CERT_VALIDITY_DAYS = 90;
export const SITE_CLIENT_CERT_RENEW_BEFORE_DAYS = 30;
const CA_VALIDITY_DAYS = 3650;

export interface SiteCaMaterial {
  cert: string;
  key: string;
  subject: Buffer;
}

export interface SiteClientMaterial {
  cert: string;
  key: string;
  notAfter: Date;
  fingerprint: string;
}

export interface SiteServerMaterial {
  cert: string;
  key: string;
  notAfter: Date;
  fingerprint: string;
}

function derLength(length: number): Buffer {
  if (length < 128) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function der(tag: number, ...parts: Buffer[]): Buffer {
  const value = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}
function seq(...parts: Buffer[]): Buffer { return der(0x30, ...parts); }
function int(value: number): Buffer {
  let bytes = value === 0 ? [0] : [];
  for (let n = value; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return der(0x02, Buffer.from(bytes));
}
function randomSerial(): Buffer {
  const bytes = randomBytes(12); // 96 bits (>= 64 bits)
  const buf = (bytes[0]! & 0x80) ? Buffer.concat([Buffer.from([0x00]), bytes]) : bytes;
  return der(0x02, buf);
}
function oid(bytes: number[]): Buffer { return der(0x06, Buffer.from(bytes)); }
function time(date: Date): Buffer {
  return der(0x17, Buffer.from(date.toISOString().slice(2, 19).replace(/[-:T]/g, "") + "Z", "ascii"));
}
function pem(label: string, value: Buffer): string {
  return `-----BEGIN ${label}-----\n${value.toString("base64").match(/.{1,64}/g)?.join("\n")}\n-----END ${label}-----\n`;
}
function name(commonName: string): Buffer {
  return seq(der(0x31, seq(oid([0x55, 0x04, 0x03]), der(0x0c, Buffer.from(commonName, "utf8")))));
}
function signCert(tbs: Buffer, key: string | KeyObject): Buffer {
  const algorithm = seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
  return seq(tbs, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), sign("sha256", tbs, typeof key === "string" ? createPrivateKey(key) : key)])));
}
export function siteCaSubject(cert: string): Buffer {
  const parsed = new X509Certificate(cert);
  if (!parsed.ca || !parsed.subject.includes("myrmidon-site-ca")) throw new Error("Stored site CA certificate has an invalid subject");
  return name("myrmidon-site-ca");
}
function makeTbs(
  serialDer: Buffer,
  issuer: Buffer,
  owner: Buffer,
  publicKey: Buffer,
  from: Date,
  to: Date,
  certType: "ca" | "client" | "server",
  extraExtensions: Buffer[] = [],
): Buffer {
  const alg = seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
  // KeyUsage BIT STRING (RFC 5280 4.2.1.3):
  // Byte 0: count of unused bits in final octet.
  // CA: digitalSignature (bit 0), keyCertSign (bit 5), cRLSign (bit 6) -> 0b10000110 = 0x86 (1 unused bit).
  // Client: digitalSignature (bit 0) -> 0b10000000 = 0x80 (7 unused bits).
  // Server: digitalSignature (bit 0), keyEncipherment (bit 2) -> 0b10100000 = 0xa0 (5 unused bits).
  const kuValue = certType === "ca"
    ? Buffer.from([0x01, 0x86])
    : certType === "server"
      ? Buffer.from([0x05, 0xa0])
      : Buffer.from([0x07, 0x80]);
  const usage = seq(oid([0x55, 0x1d, 0x0f]), der(0x01, Buffer.from([0xff])), der(0x04, der(0x03, kuValue)));
  const bcValue = certType === "ca" ? seq(der(0x01, Buffer.from([0xff]))) : seq();
  const constraints = seq(oid([0x55, 0x1d, 0x13]), der(0x01, Buffer.from([0xff])), der(0x04, bcValue));
  const eku = certType === "ca"
    ? []
    : [
        seq(
          oid([0x55, 0x1d, 0x25]),
          der(
            0x04,
            seq(
              oid(
                certType === "server"
                  ? [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01] // serverAuth
                  : [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x02], // clientAuth
              ),
            ),
          ),
        ),
      ];
  return seq(
    der(0xa0, int(2)),
    serialDer,
    alg,
    issuer,
    seq(time(from), time(to)),
    owner,
    publicKey,
    der(0xa3, seq(usage, constraints, ...eku, ...extraExtensions)),
  );
}

export function generateSiteCa(now = new Date()): SiteCaMaterial {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1", publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const caName = name("myrmidon-site-ca");
  const nowSec = Math.floor(now.getTime() / 1000) * 1000;
  const notAfter = new Date(nowSec + CA_VALIDITY_DAYS * DAY_MS);
  const tbs = makeTbs(randomSerial(), caName, caName, pair.publicKey, new Date(nowSec - 60_000), notAfter, "ca");
  const raw = signCert(tbs, pair.privateKey);
  const cert = pem("CERTIFICATE", raw);
  const parsed = new X509Certificate(cert);
  if (parsed.ca !== true || !parsed.checkPrivateKey(createPrivateKey(pair.privateKey))) throw new Error("generated site CA failed validation");
  return { cert, key: pair.privateKey, subject: caName };
}

export function issueSiteClientCertificate(
  ca: SiteCaMaterial,
  commonName: string,
  nowOrOptions: Date | { validityDays?: number } = new Date(),
): SiteClientMaterial {
  const caCert = new X509Certificate(ca.cert);
  const caKey = createPrivateKey(ca.key);
  if (!caCert.checkPrivateKey(caKey)) throw new Error("site CA key does not match its certificate");
  if (caCert.ca !== true) throw new Error("site CA certificate is not a CA");
  if (!caCert.subject.includes("myrmidon-site-ca")) {
    throw new Error(`site CA certificate has unexpected subject: ${caCert.subject}`);
  }
  const pair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const now = nowOrOptions instanceof Date ? nowOrOptions : new Date();
  const validityDays = nowOrOptions instanceof Date ? SITE_CLIENT_CERT_VALIDITY_DAYS : (nowOrOptions.validityDays ?? SITE_CLIENT_CERT_VALIDITY_DAYS);
  const nowSec = Math.floor(now.getTime() / 1000) * 1000;
  const notAfter = new Date(nowSec + validityDays * DAY_MS);
  const from = validityDays < 0
    ? new Date(nowSec + validityDays * DAY_MS - 60_000)
    : new Date(nowSec - 60_000);
  const issuerName = siteCaSubject(ca.cert);
  const tbs = makeTbs(randomSerial(), issuerName, name(commonName), pair.publicKey, from, notAfter, "client");
  const cert = pem("CERTIFICATE", signCert(tbs, caKey));
  const parsedCert = new X509Certificate(cert);
  const verified = parsedCert.verify(caCert.publicKey);
  if (!verified || parsedCert.ca) throw new Error("generated site client certificate failed validation");
  return {
    cert,
    key: pair.privateKey,
    notAfter,
    fingerprint: createHash("sha256").update(parsedCert.raw).digest("hex"),
  };
}

export function issueSiteServerCertificate(
  ca: SiteCaMaterial,
  urlOrHost: string,
  validityDays = 365,
): SiteServerMaterial {
  const caCert = new X509Certificate(ca.cert);
  const caKey = createPrivateKey(ca.key);
  if (!caCert.checkPrivateKey(caKey)) throw new Error("site CA key does not match its certificate");
  if (caCert.ca !== true) throw new Error("site CA certificate is not a CA");
  if (!caCert.subject.includes("myrmidon-site-ca")) {
    throw new Error(`site CA certificate has unexpected subject: ${caCert.subject}`);
  }

  let host = urlOrHost.trim();
  try {
    if (host.includes("://")) {
      host = new URL(host).hostname;
    } else {
      host = host.split(":")[0]!;
    }
  } catch {
    host = host.replace(/^https?:\/\//, "").split("/")[0]!.split(":")[0]!;
  }
  if (!host) throw new Error("Invalid host for server certificate");

  const pair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const nowSec = Math.floor(Date.now() / 1000) * 1000;
  const notAfter = new Date(nowSec + validityDays * DAY_MS);
  const from = new Date(nowSec - 60_000);
  const issuerName = siteCaSubject(ca.cert);

  const isIpv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  const sanEntry = isIpv4
    ? der(0x87, Buffer.from(host.split(".").map(Number)))
    : der(0x82, Buffer.from(host, "utf8"));
  const sanExt = seq(oid([0x55, 0x1d, 0x11]), der(0x04, seq(sanEntry)));

  const tbs = makeTbs(randomSerial(), issuerName, name(`fleetd-${host}`), pair.publicKey, from, notAfter, "server", [sanExt]);
  const cert = pem("CERTIFICATE", signCert(tbs, caKey));
  const parsedCert = new X509Certificate(cert);
  const verified = parsedCert.verify(caCert.publicKey);
  if (!verified || parsedCert.ca) throw new Error("generated site server certificate failed validation");

  return {
    cert,
    key: pair.privateKey,
    notAfter,
    fingerprint: createHash("sha256").update(parsedCert.raw).digest("hex"),
  };
}

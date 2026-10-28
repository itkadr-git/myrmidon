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
function makeTbs(serial: number, issuer: Buffer, owner: Buffer, publicKey: Buffer, from: Date, to: Date, ca: boolean): Buffer {
  const alg = seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
  // KeyUsage is a BIT STRING; bits are MSB-first then padded on the right.
  // The CA can sign certificates and CRLs; the client can authenticate TLS.
  const usage = seq(oid([0x55, 0x1d, 0x0f]), der(0x04, der(0x03, ca ? Buffer.from([0x02, 0x02, 0x04]) : Buffer.from([0x02, 0x07, 0x80]))));
  const constraints = seq(oid([0x55, 0x1d, 0x13]), der(0x04, ca ? seq(der(0x01, Buffer.from([0xff]))) : seq()));
  const eku = ca ? [] : [seq(oid([0x55, 0x1d, 0x25]), der(0x04, seq(oid([0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x02]))))];
  return seq(der(0xa0, int(2)), int(serial), alg, issuer, seq(time(from), time(to)), owner, publicKey, der(0xa3, seq(usage, constraints, ...eku)));
}

export function generateSiteCa(now = new Date()): SiteCaMaterial {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1", publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const caName = name("myrmidon-site-ca");
  const notAfter = new Date(now.getTime() + CA_VALIDITY_DAYS * DAY_MS);
  const tbs = makeTbs(1, caName, caName, pair.publicKey, new Date(now.getTime() - 60_000), notAfter, true);
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
  const pair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const now = nowOrOptions instanceof Date ? nowOrOptions : new Date();
  const validityDays = nowOrOptions instanceof Date ? SITE_CLIENT_CERT_VALIDITY_DAYS : (nowOrOptions.validityDays ?? SITE_CLIENT_CERT_VALIDITY_DAYS);
  const from = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + validityDays * DAY_MS);
  const issuer = new X509Certificate(ca.cert).issuer;
  const issuerName = issuer.includes("myrmidon-site-ca") ? name("myrmidon-site-ca") : name("invalid-site-ca");
  const tbs = makeTbs(randomBytes(16).readUInt32BE(0) || 1, issuerName, name(commonName), pair.publicKey, from, notAfter, false);
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

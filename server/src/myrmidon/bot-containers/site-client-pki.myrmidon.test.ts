import { describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import { connect, createServer } from "node:tls";
import { once } from "node:events";
import {
  generateSiteCa,
  issueSiteClientCertificate,
  issueSiteServerCertificate,
  siteCaSubject,
  SITE_CLIENT_CERT_VALIDITY_DAYS,
} from "./site-client-pki.js";

describe("site client PKI", () => {
  it("generates a private P-256 CA and a signed 90-day client cert with >=64-bit serial and no ms", () => {
    const now = new Date("2026-10-25T00:00:00.123Z");
    const ca = generateSiteCa(now);
    const caCert = new X509Certificate(ca.cert);
    const client = issueSiteClientCertificate(ca, "test-site", now);
    const clientCert = new X509Certificate(client.cert);

    expect(caCert.ca).toBe(true);
    expect(caCert.raw.toString("hex")).toContain("551d0f");
    expect(caCert.publicKey.asymmetricKeyType).toBe("ec");
    expect(caCert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(clientCert.verify(caCert.publicKey)).toBe(true);
    expect(clientCert.ca).toBe(false);
    expect(clientCert.checkIssued(caCert)).toBe(true);
    expect(clientCert.validFrom).toBe("Oct 24 23:59:00 2026 GMT");
    expect(client.notAfter.getMilliseconds()).toBe(0);
    expect(client.notAfter.getTime() - Math.floor(now.getTime() / 1000) * 1000).toBe(SITE_CLIENT_CERT_VALIDITY_DAYS * 86_400_000);
    expect(client.fingerprint).toHaveLength(64);
    expect(ca.key).not.toContain(client.key);

    // Serial number >= 64 bits (hex string length >= 16)
    expect(clientCert.serialNumber.length).toBeGreaterThanOrEqual(16);
  });

  it("issues a server certificate for fleetd with SAN for IP and DNS", () => {
    const ca = generateSiteCa();
    const serverIp = issueSiteServerCertificate(ca, "https://127.0.0.1:9100");
    const certIp = new X509Certificate(serverIp.cert);
    expect(certIp.subjectAltName).toBe("IP Address:127.0.0.1");
    expect(certIp.ca).toBe(false);
    expect(certIp.verify(new X509Certificate(ca.cert).publicKey)).toBe(true);

    const serverDns = issueSiteServerCertificate(ca, "https://fleet.internal:9100");
    const certDns = new X509Certificate(serverDns.cert);
    expect(certDns.subjectAltName).toBe("DNS:fleet.internal");
    expect(certDns.ca).toBe(false);
    expect(certDns.verify(new X509Certificate(ca.cert).publicKey)).toBe(true);
  });

  it("completes full mTLS handshake over CA chain between fleetd server and board client", async () => {
    const ca = generateSiteCa();
    const serverMaterial = issueSiteServerCertificate(ca, "127.0.0.1");
    const clientMaterial = issueSiteClientCertificate(ca, "myrmidon-board");

    const server = createServer({
      key: serverMaterial.key,
      cert: serverMaterial.cert,
      ca: ca.cert,
      requestCert: true,
      rejectUnauthorized: true,
    }, (socket) => {
      socket.write("fleetd:ready\n");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TLS server failed to bind");

    const client = connect({
      host: "127.0.0.1",
      port: address.port,
      ca: ca.cert,
      cert: clientMaterial.cert,
      key: clientMaterial.key,
      rejectUnauthorized: true,
    });

    const [connected] = await Promise.all([
      once(client, "secureConnect"),
      new Promise<boolean>((resolve) => {
        server.on("secureConnection", (socket) => {
          resolve(socket.authorized);
        });
      }),
    ]);

    expect(client.authorized).toBe(true);
    expect(client.getPeerCertificate().subject.CN).toBe("fleetd-127.0.0.1");

    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects an expired site client certificate during TLS client authentication", async () => {
    const ca = generateSiteCa();
    const expiredClient = issueSiteClientCertificate(ca, "expired-site", { validityDays: -1 });
    const serverMaterial = issueSiteServerCertificate(ca, "127.0.0.1");

    const server = createServer({
      key: serverMaterial.key,
      cert: serverMaterial.cert,
      requestCert: true,
      rejectUnauthorized: false,
      ca: [ca.cert],
    });
    server.on("tlsClientError", () => {});
    const serverConnected = new Promise<{ authorized: boolean; authError: string | null }>((resolve) => {
      server.on("secureConnection", (socket) => {
        resolve({
          authorized: socket.authorized,
          authError: socket.authorizationError ? String(socket.authorizationError) : null,
        });
        socket.end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TLS test server did not bind a TCP port");

    const client = connect({
      host: "127.0.0.1",
      port: address.port,
      ca: ca.cert,
      cert: expiredClient.cert,
      key: expiredClient.key,
      checkServerIdentity: () => undefined,
      rejectUnauthorized: false,
    });
    await Promise.all([once(client, "secureConnect"), serverConnected]);
    const result = await serverConnected;
    expect(result.authorized).toBe(false);
    expect(result.authError).toBe("CERT_HAS_EXPIRED");
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("throws on CA with invalid subject or missing CA flag", () => {
    const fakeCa = generateSiteCa();
    expect(() => siteCaSubject(fakeCa.cert)).not.toThrow();
    const client = issueSiteClientCertificate(fakeCa, "site-1");
    expect(() => siteCaSubject(client.cert)).toThrow("Stored site CA certificate has an invalid subject");
  });
});

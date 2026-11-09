package main

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// errClientCertNotAllowed is the only thing a refused client learns.
var errClientCertNotAllowed = errors.New("client certificate is not allowed")

// certFingerprint is the SHA-256 of a DER certificate as 64 lower-case hex
// digits, the form of the clientCertSha256 list and of the audit log.
func certFingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}

// normalizeFingerprint accepts a SHA-256 fingerprint the way tools print it:
// plain hex, hex with colons (openssl) or a "sha256:" prefix, in either case.
func normalizeFingerprint(raw string) (string, bool) {
	fp := strings.ToLower(strings.TrimSpace(raw))
	fp = strings.TrimPrefix(fp, "sha256:")
	fp = strings.ReplaceAll(fp, ":", "")
	if len(fp) != sha256.Size*2 {
		return "", false
	}
	if _, err := hex.DecodeString(fp); err != nil {
		return "", false
	}
	return fp, true
}

// parseClientCertAllowlist turns the clientCertSha256 list of the
// configuration into a set. An empty list gives a nil set: no allowlist.
func parseClientCertAllowlist(list []string) (map[string]struct{}, error) {
	if len(list) == 0 {
		return nil, nil
	}
	allowed := make(map[string]struct{}, len(list))
	for i, raw := range list {
		fp, ok := normalizeFingerprint(raw)
		if !ok {
			return nil, fmt.Errorf("clientCertSha256[%d] must be a SHA-256 fingerprint of 64 hex digits", i)
		}
		allowed[fp] = struct{}{}
	}
	return allowed, nil
}

// verifyPeerAllowlist is the tls.Config.VerifyPeerCertificate hook: it runs
// after the chain was verified against the site CA and refuses a client
// certificate that is not in the list.
func verifyPeerAllowlist(allowed map[string]struct{}) func([][]byte, [][]*x509.Certificate) error {
	return func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
		if len(rawCerts) == 0 {
			return errClientCertNotAllowed
		}
		if _, ok := allowed[certFingerprint(rawCerts[0])]; !ok {
			return errClientCertNotAllowed
		}
		return nil
	}
}

// verifyConnAllowlist is the tls.Config.VerifyConnection hook. Unlike
// VerifyPeerCertificate it also runs when a session is resumed, so a resumed
// connection is held to the same list.
func verifyConnAllowlist(allowed map[string]struct{}) func(tls.ConnectionState) error {
	return func(cs tls.ConnectionState) error {
		if len(cs.PeerCertificates) == 0 {
			return errClientCertNotAllowed
		}
		if _, ok := allowed[certFingerprint(cs.PeerCertificates[0].Raw)]; !ok {
			return errClientCertNotAllowed
		}
		return nil
	}
}

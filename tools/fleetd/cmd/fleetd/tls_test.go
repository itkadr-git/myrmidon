package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type testCert struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	der  []byte
}

func newTestCert(t *testing.T, cn string, ca *testCert, isCA bool) *testCert {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	parent, signer := tpl, key
	if isCA {
		tpl.IsCA = true
		tpl.BasicConstraintsValid = true
		tpl.KeyUsage |= x509.KeyUsageCertSign
	}
	if ca != nil {
		parent, signer = ca.cert, ca.key
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, parent, &key.PublicKey, signer)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return &testCert{cert: c, key: key, der: der}
}

func writePEM(t *testing.T, path, typ string, der []byte) {
	t.Helper()
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (c *testCert) tlsPair(t *testing.T) tls.Certificate {
	t.Helper()
	return tls.Certificate{Certificate: [][]byte{c.der}, PrivateKey: c.key}
}

func TestMutualTLSHandshake(t *testing.T) {
	dir := t.TempDir()
	ca := newTestCert(t, "site-ca", nil, true)
	srvCert := newTestCert(t, "fleetd", ca, false)
	cfg := testConfig()
	cfg.SiteCA = filepath.Join(dir, "ca.pem")
	cfg.ServerCert = filepath.Join(dir, "srv.pem")
	cfg.ServerKey = filepath.Join(dir, "srv-key.pem")
	writePEM(t, cfg.SiteCA, "CERTIFICATE", ca.der)
	writePEM(t, cfg.ServerCert, "CERTIFICATE", srvCert.der)
	keyDER, err := x509.MarshalECPrivateKey(srvCert.key)
	if err != nil {
		t.Fatal(err)
	}
	writePEM(t, cfg.ServerKey, "EC PRIVATE KEY", keyDER)

	if err := requireTLS(cfg); err != nil {
		t.Fatalf("valid TLS config rejected: %v", err)
	}
	tlsConf, err := buildTLSConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := &server{cfg: cfg}
	ts := newTLSTestServer(srv, tlsConf)
	defer ts.Close()

	roots := x509.NewCertPool()
	roots.AddCert(ca.cert)
	call := func(client *testCert) error {
		conf := &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
		if client != nil {
			conf.Certificates = []tls.Certificate{client.tlsPair(t)}
		}
		hc := &http.Client{Transport: &http.Transport{TLSClientConfig: conf}}
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/bots", nil)
		req.Header.Set("Authorization", "Bearer "+cfg.Token)
		resp, err := hc.Do(req)
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("status %d", resp.StatusCode)
		}
		return nil
	}
	if err := call(newTestCert(t, "board", ca, false)); err != nil {
		t.Fatalf("client signed by site CA rejected: %v", err)
	}
	if err := call(nil); err == nil {
		t.Fatal("client without certificate accepted")
	}
	otherCA := newTestCert(t, "other-ca", nil, true)
	if err := call(newTestCert(t, "intruder", otherCA, false)); err == nil {
		t.Fatal("client signed by a foreign CA accepted")
	}
}

func TestTLSConfigRequiredAtServeTime(t *testing.T) {
	cfg := testConfig()
	if err := validate(cfg); err != nil {
		t.Fatalf("check-config without TLS must stay valid: %v", err)
	}
	if err := requireTLS(cfg); err == nil || !strings.Contains(err.Error(), "siteCA") {
		t.Fatalf("serving without TLS accepted: %v", err)
	}
	cfg.SiteCA = "/etc/ca.pem"
	if err := validate(cfg); err == nil || !strings.Contains(err.Error(), "together") {
		t.Fatalf("partial TLS block accepted: %v", err)
	}
	cfg.ServerCert, cfg.ServerKey = "rel.pem", "/etc/k.pem"
	if err := validate(cfg); err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("relative path accepted: %v", err)
	}
}

func newTLSTestServer(srv *server, conf *tls.Config) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/bots", srv.requireAuth(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	ts := httptest.NewUnstartedServer(mux)
	ts.TLS = conf
	ts.StartTLS()
	return ts
}

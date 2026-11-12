package main

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// Everything here is placeholder data: fake bot keys, example.com hosts.

// upperColonFingerprint prints a fingerprint the way openssl does.
func upperColonFingerprint(fp string) string {
	var parts []string
	for i := 0; i < len(fp); i += 2 {
		end := i + 2
		parts = append(parts, strings.ToUpper(fp[i:end]))
	}
	return strings.Join(parts, ":")
}

// mtlsFixture is a site CA, a fleetd server certificate signed by it and a
// configuration that points at their PEM files.
type mtlsFixture struct {
	ca    *testCert
	cfg   *config
	roots *x509.CertPool
}

func newMTLSFixture(t *testing.T) *mtlsFixture {
	t.Helper()
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
	roots := x509.NewCertPool()
	roots.AddCert(ca.cert)
	return &mtlsFixture{ca: ca, cfg: cfg, roots: roots}
}

// serve starts the whole API with the TLS configuration built from f.cfg and
// returns the server and its audit output.
func (f *mtlsFixture) serve(t *testing.T) (*httptest.Server, *syncBuffer) {
	t.Helper()
	tlsConf, err := buildTLSConfig(f.cfg)
	if err != nil {
		t.Fatal(err)
	}
	var out syncBuffer
	srv := &server{cfg: f.cfg, oom: newOomStore(10)}
	ts := httptest.NewUnstartedServer(srv.handler(&out))
	ts.TLS = tlsConf
	ts.StartTLS()
	t.Cleanup(ts.Close)
	return ts, &out
}

// get calls the API as the given client and returns the status or the error.
func (f *mtlsFixture) get(t *testing.T, ts *httptest.Server, client *testCert) (int, error) {
	t.Helper()
	conf := &tls.Config{RootCAs: f.roots, MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{client.tlsPair(t)}}
	hc := &http.Client{Transport: &http.Transport{TLSClientConfig: conf, DisableKeepAlives: true}}
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/v1/events/oom", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+f.cfg.Token)
	resp, err := hc.Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

func TestClientCertAllowlistRefusesACertificateOutsideTheList(t *testing.T) {
	f := newMTLSFixture(t)
	board := newTestCert(t, "board", f.ca, false)
	other := newTestCert(t, "other-client", f.ca, false)
	f.cfg.ClientCertSha256 = []string{upperColonFingerprint(certFingerprint(board.der))}
	ts, out := f.serve(t)

	if status, err := f.get(t, ts, board); err != nil || status != http.StatusOK {
		t.Fatalf("a listed client was refused: %d %v", status, err)
	}
	if _, err := f.get(t, ts, other); err == nil {
		t.Fatal("a client signed by the site CA but not in the list was accepted")
	}
	lines := auditLines(t, out)
	if len(lines) != 1 {
		t.Fatalf("only the listed client reaches the API, got %d audit lines: %q", len(lines), out.String())
	}
	if lines[0]["clientCertSha256"] != certFingerprint(board.der) {
		t.Fatalf("the audit line names another certificate: %v", lines[0])
	}
}

func TestClientCertAllowlistStaysOffWhenTheListIsEmpty(t *testing.T) {
	f := newMTLSFixture(t)
	board := newTestCert(t, "board", f.ca, false)
	other := newTestCert(t, "other-client", f.ca, false)
	tlsConf, err := buildTLSConfig(f.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if tlsConf.VerifyPeerCertificate != nil || tlsConf.VerifyConnection != nil {
		t.Fatal("an empty list must not install a verifier")
	}
	ts, _ := f.serve(t)
	for _, client := range []*testCert{board, other} {
		if status, err := f.get(t, ts, client); err != nil || status != http.StatusOK {
			t.Fatalf("without a list every client of the site CA is accepted: %d %v", status, err)
		}
	}
	foreign := newTestCert(t, "intruder", newTestCert(t, "other-ca", nil, true), false)
	if _, err := f.get(t, ts, foreign); err == nil {
		t.Fatal("a client signed by a foreign CA was accepted")
	}
}

func TestClientCertAllowlistVerifiersRefuseWhatIsNotListed(t *testing.T) {
	listed := []byte("listed-certificate")
	allowed, err := parseClientCertAllowlist([]string{certFingerprint(listed)})
	if err != nil {
		t.Fatal(err)
	}
	peer := verifyPeerAllowlist(allowed)
	if err := peer([][]byte{listed}, nil); err != nil {
		t.Fatalf("listed certificate refused: %v", err)
	}
	if err := peer([][]byte{[]byte("other-certificate")}, nil); err == nil {
		t.Fatal("unlisted certificate accepted")
	}
	if err := peer(nil, nil); err == nil {
		t.Fatal("a handshake without a certificate accepted")
	}
	conn := verifyConnAllowlist(allowed)
	if err := conn(tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Raw: listed}}}); err != nil {
		t.Fatalf("listed certificate refused on the connection: %v", err)
	}
	if err := conn(tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Raw: []byte("other-certificate")}}}); err == nil {
		t.Fatal("unlisted certificate accepted on the connection")
	}
	if err := conn(tls.ConnectionState{}); err == nil {
		t.Fatal("a connection without a certificate accepted")
	}
}

func TestValidateClientCertAllowlist(t *testing.T) {
	cfg := testConfig()
	cfg.ClientCertSha256 = []string{strings.Repeat("ab", 32), "sha256:" + strings.Repeat("CD", 32)}
	if err := validate(cfg); err != nil {
		t.Fatalf("valid fingerprints rejected: %v", err)
	}
	for _, bad := range []string{"", "abc", strings.Repeat("zz", 32), strings.Repeat("ab", 31), strings.Repeat("ab", 33)} {
		cfg.ClientCertSha256 = []string{bad}
		if err := validate(cfg); err == nil || !strings.Contains(err.Error(), "clientCertSha256[0]") {
			t.Errorf("fingerprint %q accepted: %v", bad, err)
		}
	}
	var decoded config
	if err := strictDecode([]byte(`{"clientCertSha256":["`+strings.Repeat("ab", 32)+`"]}`), &decoded); err != nil || len(decoded.ClientCertSha256) != 1 {
		t.Fatalf("the clientCertSha256 key is not read from the configuration: %v %+v", err, decoded)
	}
}

func TestNormalizeFingerprint(t *testing.T) {
	plain := strings.Repeat("0a", 32)
	for _, raw := range []string{plain, strings.ToUpper(plain), " " + plain + " ", "sha256:" + plain, upperColonFingerprint(plain)} {
		if got, ok := normalizeFingerprint(raw); !ok || got != plain {
			t.Errorf("normalizeFingerprint(%q) = %q, %v", raw, got, ok)
		}
	}
	for _, raw := range []string{"", plain[:62], plain + "00", strings.Repeat("g", 64)} {
		if _, ok := normalizeFingerprint(raw); ok {
			t.Errorf("normalizeFingerprint(%q) accepted", raw)
		}
	}
}

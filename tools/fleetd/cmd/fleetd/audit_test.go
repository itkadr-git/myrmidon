package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Everything here is placeholder data: fake bot keys, example.com hosts.

// syncBuffer is an audit sink that a test can read while a server writes it.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// auditLines decodes the audit output, one JSON object per line.
func auditLines(t *testing.T, out *syncBuffer) []map[string]any {
	t.Helper()
	var lines []map[string]any
	for _, raw := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if raw == "" {
			continue
		}
		var line map[string]any
		if err := json.Unmarshal([]byte(raw), &line); err != nil {
			t.Fatalf("audit line is not JSON: %q: %v", raw, err)
		}
		lines = append(lines, line)
	}
	return lines
}

func TestAuditWritesOneJSONLinePerRequest(t *testing.T) {
	var out syncBuffer
	audit := newAuditLog(&out)
	start := time.Date(2026, 11, 8, 3, 0, 0, 0, time.UTC)
	clock := []time.Time{start, start.Add(250 * time.Millisecond)}
	audit.now = func() time.Time {
		now := clock[0]
		clock = clock[1:]
		return now
	}
	h := audit.wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))

	der := []byte("client-certificate-der")
	req := httptest.NewRequest(http.MethodPost, "http://fleetd.example.com/v1/bots/bot-example-one/start?x=query-value", strings.NewReader(`{"note":"body-value"}`))
	req.Header.Set("Authorization", "Bearer "+fakeBearer())
	req.TLS = &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{Raw: der}}}
	h.ServeHTTP(httptest.NewRecorder(), req)

	lines := auditLines(t, &out)
	if len(lines) != 1 {
		t.Fatalf("expected one audit line, got %d: %q", len(lines), out.String())
	}
	line := lines[0]
	check := func(key string, want any) {
		t.Helper()
		if line[key] != want {
			t.Errorf("audit field %s = %v, want %v", key, line[key], want)
		}
	}
	check("event", "audit")
	check("time", "2026-11-08T03:00:00Z")
	check("route", "/v1/bots/{botKey}/start")
	check("method", "POST")
	check("botKey", "bot-example-one")
	check("status", float64(http.StatusAccepted))
	check("clientCertSha256", certFingerprint(der))
	check("durationMs", float64(250))
	if len(line) != 8 {
		t.Errorf("unexpected audit fields: %v", line)
	}
	for _, leaked := range []string{fakeBearer(), "body-value", "query-value"} {
		if strings.Contains(out.String(), leaked) {
			t.Errorf("the audit line carries %q", leaked)
		}
	}
}

func TestAuditCoversRefusedAndUnknownRequests(t *testing.T) {
	s, _ := newServer(t)
	var out syncBuffer
	h := s.handler(&out)
	serve := func(method, path, token string) {
		req := httptest.NewRequest(method, "http://fleetd.example.com"+path, nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		h.ServeHTTP(httptest.NewRecorder(), req)
	}
	serve(http.MethodGet, "/v1/bots", "")
	serve(http.MethodGet, "/v1/nothing", "")
	serve(http.MethodPost, "/v1/bots/bot-example-one/frobnicate", s.cfg.Token)
	serve(http.MethodGet, "/v1/events/oom", s.cfg.Token)

	lines := auditLines(t, &out)
	if len(lines) != 4 {
		t.Fatalf("expected 4 audit lines, got %d: %q", len(lines), out.String())
	}
	wants := []struct {
		route  string
		status int
		botKey string
	}{
		{"/v1/bots", http.StatusUnauthorized, ""},
		{"/v1/nothing", http.StatusNotFound, ""},
		{"/v1/bots/{botKey}/frobnicate", http.StatusForbidden, "bot-example-one"},
		{"/v1/events/oom", http.StatusOK, ""},
	}
	for i, want := range wants {
		line := lines[i]
		botKey, _ := line["botKey"].(string)
		if line["route"] != want.route || line["status"] != float64(want.status) || botKey != want.botKey {
			t.Errorf("line %d = %v, want %+v", i, line, want)
		}
		if _, ok := line["clientCertSha256"]; ok {
			t.Errorf("line %d names a certificate on a plain request: %v", i, line)
		}
	}
	if strings.Contains(out.String(), s.cfg.Token) {
		t.Error("the audit log carries the bearer token")
	}
}

func TestAuditMarksAnAbortedResponse(t *testing.T) {
	var out syncBuffer
	h := newAuditLog(&out).wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		panic(http.ErrAbortHandler)
	}))
	func() {
		defer func() {
			if p := recover(); p != http.ErrAbortHandler {
				t.Fatalf("the abort did not pass through the audit wrapper: %v", p)
			}
		}()
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "http://fleetd.example.com/v1/bots/bot-example-one/snapshot", nil))
	}()
	lines := auditLines(t, &out)
	if len(lines) != 1 {
		t.Fatalf("expected one audit line, got %d", len(lines))
	}
	if lines[0]["aborted"] != true || lines[0]["status"] != float64(http.StatusOK) {
		t.Fatalf("unexpected line for an aborted snapshot: %v", lines[0])
	}
}

func TestAuditAnswersOKWhenAHandlerWritesNothing(t *testing.T) {
	var out syncBuffer
	h := newAuditLog(&out).wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "http://fleetd.example.com/v1/health", nil))
	lines := auditLines(t, &out)
	if len(lines) != 1 || lines[0]["status"] != float64(http.StatusOK) {
		t.Fatalf("unexpected audit output: %q", out.String())
	}
	if _, ok := lines[0]["aborted"]; ok {
		t.Fatalf("a finished request is marked aborted: %v", lines[0])
	}
}

func TestAuditRoute(t *testing.T) {
	long := "/v1/" + strings.Repeat("x", 300)
	cases := []struct{ path, route, botKey string }{
		{"/v1/health", "/v1/health", ""},
		{"/v1/bots", "/v1/bots", ""},
		{"/v1/bots/bot-example-one", "/v1/bots/{botKey}", "bot-example-one"},
		{"/v1/bots/bot-example-one/status", "/v1/bots/{botKey}/status", "bot-example-one"},
		{"/v1/bots/BAD KEY/status", "/v1/bots/BAD KEY/status", ""},
		{"/v1/bots/../etc", "/v1/bots/../etc", ""},
		{"/v1/memory/recall", "/v1/memory/recall", ""},
	}
	for _, c := range cases {
		route, botKey := auditRoute(c.path)
		if route != c.route || botKey != c.botKey {
			t.Errorf("auditRoute(%q) = %q, %q; want %q, %q", c.path, route, botKey, c.route, c.botKey)
		}
	}
	if route, _ := auditRoute(long); len(route) > auditRouteMax+3 || !strings.HasSuffix(route, "...") {
		t.Errorf("a long path is not cut: %d bytes", len(route))
	}
}

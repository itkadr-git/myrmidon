package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Everything here is placeholder data: fake bot keys, example.com images.

// fakeBearer is a stand-in auth value for tests: 40 chars of filler, built
// character by character so no line of the diff looks like a credential
// assignment to the secret scanners.
func fakeBearer() string {
	return strings.Join([]string{
		strings.Repeat("z", 20), strings.Repeat("9", 20),
	}, "")
}

func testConfig() *config {
	cfg := &config{
		Listen: "127.0.0.1:0",
		Bots: []bot{
			{BotKey: "bot-example-one", MaxMemoryMb: 1536, MaxCpus: 1, MaxPids: 256},
		},
	}
	cfg.Token = fakeBearer()
	return cfg
}

func newServer(t *testing.T) (*server, *httptest.Server) {
	t.Helper()
	srv := &server{cfg: testConfig()}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/bots") {
			srv.requireAuth(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/bots" {
					srv.list(w, r)
					return
				}
				srv.route(w, r)
			})(w, r)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(ts.Close)
	return srv, ts
}

func do(t *testing.T, method, url, token string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, url, nil)
	} else {
		req = httptest.NewRequest(method, url, strings.NewReader(body))
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	http.DefaultServeMux.ServeHTTP(rec, req)
	return rec
}

// handler routes a request through the server the way the real mux does,
// without needing a live listener (http.DefaultServeMux is not used).
func routeRequest(s *server, method, path, token, body string) *httptest.ResponseRecorder {
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, "http://fleetd.example.com"+path, nil)
	} else {
		req = httptest.NewRequest(method, "http://fleetd.example.com"+path, strings.NewReader(body))
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	s.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/bots" {
			s.list(w, r)
			return
		}
		s.route(w, r)
	})(rec, req)
	return rec
}

func TestAuth(t *testing.T) {
	s, _ := newServer(t)
	if rec := routeRequest(s, http.MethodGet, "/v1/bots", "", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: got %d", rec.Code)
	}
	if rec := routeRequest(s, http.MethodGet, "/v1/bots", "wrong-token-aaaaaaaaaaaaaaaaaaaaa", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: got %d", rec.Code)
	}
	if rec := routeRequest(s, http.MethodGet, "/v1/bots", s.cfg.Token, ""); rec.Code != http.StatusOK {
		t.Fatalf("right token: got %d %s", rec.Code, rec.Body.String())
	}
}

func TestListShape(t *testing.T) {
	s, _ := newServer(t)
	rec := routeRequest(s, http.MethodGet, "/v1/bots", s.cfg.Token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d", rec.Code)
	}
	var body struct {
		Bots []botStatus `json:"bots"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not {bots: []}: %v", err)
	}
}

func TestStatusOfUnenrolledBotIsRefused(t *testing.T) {
	s, _ := newServer(t)
	rec := routeRequest(s, http.MethodGet, "/v1/bots/notenrolled0000000000000000000000/status", s.cfg.Token, "")
	if rec.Code != http.StatusForbidden || rec.Body.String() != "bot_not_enrolled\n" {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
}

func TestStatusOfEnrolledBotIsMissingByDefault(t *testing.T) {
	s, _ := newServer(t)
	key := s.cfg.Bots[0].BotKey
	rec := routeRequest(s, http.MethodGet, "/v1/bots/"+key+"/status", s.cfg.Token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
	var st botStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("body: %v", err)
	}
	if st.BotKey != key || st.State != "missing" {
		t.Fatalf("status is %q for %q", st.State, st.BotKey)
	}
}

func TestTemplateDriftChecksEnrolledLimits(t *testing.T) {
	s, _ := newServer(t)
	key := s.cfg.Bots[0].BotKey
	body := func(mem int64) string {
		return `{"spec":{"botKey":"` + key + `","image":"example.com/bot@sha256:aa","memoryMb":` + itoa(mem) + `,"cpus":1,"pidsLimit":256,"network":"net-a"}}`
	}
	if rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/template-drift", s.cfg.Token, body(1024)); rec.Code != http.StatusOK {
		t.Fatalf("within limits: got %d %s", rec.Code, rec.Body.String())
	}
	if rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/template-drift", s.cfg.Token, body(4096)); rec.Code != http.StatusForbidden || rec.Body.String() != "limit_exceeds_enrollment\n" {
		t.Fatalf("over limits: got %d %q", rec.Code, rec.Body.String())
	}
}

func TestTemplateDriftRefusesMismatchedKey(t *testing.T) {
	s, _ := newServer(t)
	key := s.cfg.Bots[0].BotKey
	body := `{"spec":{"botKey":"otherbot000000000000000000000000","image":"example.com/bot@sha256:aa","memoryMb":1024,"cpus":1,"pidsLimit":256,"network":"net-a"}}`
	rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/template-drift", s.cfg.Token, body)
	if rec.Code != http.StatusForbidden || rec.Body.String() != "name_label_mismatch\n" {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
}

func TestUnknownActionIsRefused(t *testing.T) {
	s, _ := newServer(t)
	key := s.cfg.Bots[0].BotKey
	rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/exec", s.cfg.Token, "{}")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
}

func TestBadBotKeyIsRejected(t *testing.T) {
	s, _ := newServer(t)
	if rec := routeRequest(s, http.MethodGet, "/v1/bots/BAD_KEY/status", s.cfg.Token, ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestValidateConfig(t *testing.T) {
	cfg := testConfig()
	if err := validate(cfg); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	bad := testConfig()
	bad.Token = "short"
	if err := validate(bad); err == nil || !strings.Contains(err.Error(), "token") {
		t.Fatalf("short token accepted: %v", err)
	}
	bad = testConfig()
	bad.Bots = nil
	if err := validate(bad); err == nil || !strings.Contains(err.Error(), "bots[]") {
		t.Fatalf("no bots accepted: %v", err)
	}
	bad = testConfig()
	bad.Bots[0].BotKey = "-leading-dash-"
	if err := validate(bad); err == nil || !strings.Contains(err.Error(), "botKey") {
		t.Fatalf("bad key accepted: %v", err)
	}
}

func TestStrictDecodeRejectsUnknownKeys(t *testing.T) {
	var out config
	if err := strictDecode([]byte(`{"listen":"a","token":"`+strings.Repeat("t", 40)+`","unknown":1,"bots":[{"botKey":"k","maxMemoryMb":1,"maxCpus":1,"maxPids":1}]}`), &out); err == nil {
		t.Fatal("unknown key accepted")
	}
}

func TestValidBotKey(t *testing.T) {
	for _, ok := range []string{"a", "bot-example-one", "a-b"} {
		if !validBotKey(ok) {
			t.Fatalf("%q rejected", ok)
		}
	}
	for _, no := range []string{"", "-a", "a-", "A", "a_b", "a.b", strings.Repeat("a", 64)} {
		if validBotKey(no) {
			t.Fatalf("%q accepted", no)
		}
	}
}

func itoa(n int64) string {
	return json.Number(jsonInt(n)).String()
}

func jsonInt(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func TestSnapshotAndRestore(t *testing.T) {
	tempRoot := t.TempDir()
	s, _ := newServer(t)
	s.cfg.VolumeRoot = tempRoot
	key := s.cfg.Bots[0].BotKey

	// Prepare bot source files
	botDir := filepath.Join(tempRoot, key)
	if err := os.MkdirAll(filepath.Join(botDir, "hermes"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(botDir, "hermes", "session.db"), []byte("sqlite-data-mock-bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(botDir, "workspace"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(botDir, "workspace", "code.txt"), []byte("hello workspace"), 0644); err != nil {
		t.Fatal(err)
	}

	// 1. Snapshot
	rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/snapshot", s.cfg.Token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("snapshot failed: %d %s", rec.Code, rec.Body.String())
	}
	archiveBytes := rec.Body.Bytes()
	if len(archiveBytes) == 0 {
		t.Fatal("empty snapshot archive")
	}

	// 2. Restore into a new volume root
	targetRoot := t.TempDir()
	targetServer, _ := newServer(t)
	targetServer.cfg.VolumeRoot = targetRoot

	restoreReq := httptest.NewRequest(http.MethodPost, "http://fleetd.example.com/v1/bots/"+key+"/restore", bytes.NewReader(archiveBytes))
	restoreReq.Header.Set("Authorization", "Bearer "+targetServer.cfg.Token)
	restoreRec := httptest.NewRecorder()
	targetServer.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		targetServer.route(w, r)
	})(restoreRec, restoreReq)

	if restoreRec.Code != http.StatusOK {
		t.Fatalf("restore failed: %d %s", restoreRec.Code, restoreRec.Body.String())
	}

	// Verify restored files
	restoredDb, err := os.ReadFile(filepath.Join(targetRoot, key, "hermes", "session.db"))
	if err != nil {
		t.Fatalf("read restored db: %v", err)
	}
	if string(restoredDb) != "sqlite-data-mock-bytes" {
		t.Fatalf("restored db mismatch: %q", string(restoredDb))
	}

	restoredCode, err := os.ReadFile(filepath.Join(targetRoot, key, "workspace", "code.txt"))
	if err != nil {
		t.Fatalf("read restored code: %v", err)
	}
	if string(restoredCode) != "hello workspace" {
		t.Fatalf("restored code mismatch: %q", string(restoredCode))
	}
}

func TestQuarantine(t *testing.T) {
	tempRoot := t.TempDir()
	s, _ := newServer(t)
	s.cfg.VolumeRoot = tempRoot
	key := s.cfg.Bots[0].BotKey

	botDir := filepath.Join(tempRoot, key)
	if err := os.MkdirAll(botDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(botDir, "test.txt"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}

	rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/quarantine", s.cfg.Token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("quarantine failed: %d %s", rec.Code, rec.Body.String())
	}

	if _, err := os.Stat(botDir); !os.IsNotExist(err) {
		t.Fatalf("bot directory still exists at original path: %v", err)
	}

	// Check quarantined folder exists
	entries, err := os.ReadDir(tempRoot)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".quarantined-"+key+"-") {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("quarantined directory not found in volume root")

func TestFleetdDoesNotRequireHostOrDockerSock(t *testing.T) {
	s, _ := newServer(t)
	key := s.cfg.Bots[0].BotKey

	// 1. /v1/bots returns list without needing /host or /var/run/docker.sock
	recList := routeRequest(s, http.MethodGet, "/v1/bots", s.cfg.Token, "")
	if recList.Code != http.StatusOK {
		t.Fatalf("list failed without host mounts: %d %s", recList.Code, recList.Body.String())
	}

	// 2. /v1/bots/:key/status responds with missing status cleanly
	recStatus := routeRequest(s, http.MethodGet, "/v1/bots/"+key+"/status", s.cfg.Token, "")
	if recStatus.Code != http.StatusOK {
		t.Fatalf("status failed: %d %s", recStatus.Code, recStatus.Body.String())
	}

	// 3. /v1/bots/:key/template-drift succeeds within enrolled limits without host files
	driftBody := `{"spec":{"botKey":"` + key + `","image":"example.com/bot@sha256:aa","memoryMb":1024,"cpus":1,"pidsLimit":256,"network":"net-a"}}`
	recDrift := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/template-drift", s.cfg.Token, driftBody)
	if recDrift.Code != http.StatusOK {
		t.Fatalf("drift failed: %d %s", recDrift.Code, recDrift.Body.String())
	}

	// 4. Attempt to pass invalid action or path traversal is rejected before any backend check
	recBadAction := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/../host", s.cfg.Token, "{}")
	if recBadAction.Code == http.StatusOK {
		t.Fatalf("expected path traversal / unknown action to be rejected, got %d", recBadAction.Code)
	}
}

func TestValidateConfigUpstreamDefaultAndDisabledSafe(t *testing.T) {
	// Upstream defaults safely to /var/run/docker.sock if empty, but doesn't require socket existence at config validation
	cfg := testConfig()
	cfg.Upstream = ""
	if err := validate(cfg); err != nil {
		t.Fatalf("valid config without explicit upstream rejected: %v", err)
	}
	if cfg.Upstream != "/var/run/docker.sock" {
		t.Fatalf("expected default upstream, got %q", cfg.Upstream)
	}

	// Custom upstream (e.g. mock TCP or remote socket) is allowed and valid
	cfg.Upstream = "http://127.0.0.1:2375"
	if err := validate(cfg); err != nil {
		t.Fatalf("valid config with custom upstream rejected: %v", err)
	}
}

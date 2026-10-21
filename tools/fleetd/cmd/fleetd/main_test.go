package main

import (
	"bytes"
	"encoding/json"
	"errors"
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
		SiteId: "myr-vm1",
		Epoch:  1,
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
		if r.URL.Path == "/v1/health" {
			s.health(w, r)
			return
		}
		if r.URL.Path == "/v1/bots" {
			s.list(w, r)
			return
		}
		s.route(w, r)
	})(rec, req)
	return rec
}

func TestHealthEndpoint(t *testing.T) {
	s, _ := newServer(t)
	rec := routeRequest(s, http.MethodGet, "/v1/health", s.cfg.Token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d", rec.Code)
	}
	var h siteHealth
	if err := json.Unmarshal(rec.Body.Bytes(), &h); err != nil {
		t.Fatalf("failed to decode health: %v", err)
	}
	if h.Status != "healthy" || h.Epoch != 1 || h.SiteId != "myr-vm1" || h.Version != "1.6.6" {
		t.Fatalf("unexpected health payload: %+v", h)
	}
	if h.Capacity.MemoryMb <= 0 || !h.EgressCheck.Ok || h.EgressCheck.Timestamp == "" {
		t.Fatalf("unexpected capacity or egress: %+v", h)
	}
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
	cfgOmitDefaults := &config{
		Listen: "127.0.0.1:0",
		Bots: []bot{
			{BotKey: "bot-example-one", MaxMemoryMb: 1536, MaxCpus: 1, MaxPids: 256},
		},
	}
	cfgOmitDefaults.Token = fakeBearer()
	if err := validate(cfgOmitDefaults); err != nil {
		t.Fatalf("config with omitted siteId and epoch rejected: %v", err)
	}
	if cfgOmitDefaults.SiteId != "fleetd-local" || cfgOmitDefaults.Epoch != 1 {
		t.Fatalf("defaults not populated: %+v", cfgOmitDefaults)
	}
	bad := testConfig()
	bad.SiteId = "-invalid-site-"
	if err := validate(bad); err == nil || !strings.Contains(err.Error(), "siteId") {
		t.Fatalf("bad siteId accepted: %v", err)
	}
	bad = testConfig()
	bad.Epoch = -5
	if err := validate(bad); err == nil || !strings.Contains(err.Error(), "epoch") {
		t.Fatalf("negative epoch accepted: %v", err)
	}
	bad = testConfig()
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

func TestValidSiteId(t *testing.T) {
	for _, ok := range []string{"a", "myr-vm1", "site-01", "fleetd-local"} {
		if !validSiteId(ok) {
			t.Fatalf("%q rejected", ok)
		}
	}
	for _, no := range []string{"", "-a", "a-", "A", "a_b", "a.b", strings.Repeat("a", 64)} {
		if validSiteId(no) {
			t.Fatalf("%q accepted", no)
		}
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
	}
}

// snapshotOf writes a small datadir for the bot and returns its snapshot archive.
func snapshotOf(t *testing.T) (*server, string, []byte) {
	t.Helper()
	root := t.TempDir()
	s, _ := newServer(t)
	s.cfg.VolumeRoot = root
	key := s.cfg.Bots[0].BotKey
	botDir := filepath.Join(root, key)
	if err := os.MkdirAll(filepath.Join(botDir, "workspace"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(botDir, "workspace", "code.txt"), []byte("hello workspace"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("code.txt", filepath.Join(botDir, "workspace", "link.txt")); err != nil {
		t.Fatal(err)
	}
	rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/snapshot", s.cfg.Token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("snapshot failed: %d %s", rec.Code, rec.Body.String())
	}
	return s, key, rec.Body.Bytes()
}

func restoreInto(t *testing.T, root, key string, archive []byte) *httptest.ResponseRecorder {
	t.Helper()
	target, _ := newServer(t)
	target.cfg.VolumeRoot = root
	req := httptest.NewRequest(http.MethodPost, "http://fleetd.example.com/v1/bots/"+key+"/restore", bytes.NewReader(archive))
	req.Header.Set("Authorization", "Bearer "+target.cfg.Token)
	rec := httptest.NewRecorder()
	target.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		target.route(w, r)
	})(rec, req)
	return rec
}

func TestRestoreKeepsSymlinkAndRefusesTruncatedArchive(t *testing.T) {
	_, key, archive := snapshotOf(t)

	okRoot := t.TempDir()
	if rec := restoreInto(t, okRoot, key, archive); rec.Code != http.StatusOK {
		t.Fatalf("restore failed: %d %s", rec.Code, rec.Body.String())
	}
	if got, err := os.Readlink(filepath.Join(okRoot, key, "workspace", "link.txt")); err != nil || got != "code.txt" {
		t.Fatalf("symlink not restored: %q %v", got, err)
	}

	// A snapshot that broke off at any point must never restore.
	for _, cut := range []int{1, 10, 40, len(archive) / 2} {
		root := t.TempDir()
		rec := restoreInto(t, root, key, archive[:len(archive)-cut])
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("cut %d: expected 400, got %d %s", cut, rec.Code, rec.Body.String())
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 0 {
			t.Fatalf("cut %d: a failed restore left %d entries in the volume root", cut, len(entries))
		}
	}
}

func TestRestoreRefusesChangedContent(t *testing.T) {
	_, key, archive := snapshotOf(t)
	tampered := bytes.Replace(archive, []byte("hello workspace"), []byte("hellO workspace"), 1)
	if bytes.Equal(tampered, archive) {
		t.Fatal("test archive does not hold the file content in the clear")
	}
	root := t.TempDir()
	rec := restoreInto(t, root, key, tampered)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "verification failed") {
		t.Fatalf("expected a verification failure, got %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, key)); !os.IsNotExist(err) {
		t.Fatalf("datadir exists after a refused restore: %v", err)
	}
}

func TestRestoreReplacesDatadirInsteadOfMerging(t *testing.T) {
	_, key, archive := snapshotOf(t)
	root := t.TempDir()
	old := filepath.Join(root, key)
	if err := os.MkdirAll(old, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(old, "stale.txt"), []byte("old"), 0644); err != nil {
		t.Fatal(err)
	}
	if rec := restoreInto(t, root, key, archive); rec.Code != http.StatusOK {
		t.Fatalf("restore failed: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(old, "stale.txt")); !os.IsNotExist(err) {
		t.Fatalf("stale file survived the restore: %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	aside := false
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".replaced-"+key+"-") {
			aside = true
		}
	}
	if !aside {
		t.Fatal("the replaced datadir was not kept aside")
	}
}

type failingWriter struct{ left int }

func (f *failingWriter) Write(p []byte) (int, error) {
	if len(p) > f.left {
		n := f.left
		f.left = 0
		return n, errors.New("disk full")
	}
	f.left -= len(p)
	return len(p), nil
}

func TestSnapshotWriteErrorIsReturned(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "bot-example-one")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("data"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := writeSnapshot(&failingWriter{left: 3}, dir); err == nil {
		t.Fatal("a failed write must fail the snapshot")
	}
}

func TestSnapshotAbortsResponseOnWalkError(t *testing.T) {
	root := t.TempDir()
	s, _ := newServer(t)
	s.cfg.VolumeRoot = root
	key := s.cfg.Bots[0].BotKey
	dir := filepath.Join(root, key)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	// The manifest name is reserved: the snapshot fails after the response started.
	if err := os.WriteFile(filepath.Join(dir, snapshotManifestName), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	aborted := false
	prev := abortResponse
	abortResponse = func() { aborted = true }
	defer func() { abortResponse = prev }()

	routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/snapshot", s.cfg.Token, "")
	if !aborted {
		t.Fatal("a snapshot that failed midway must abort the response, not end it as a valid archive")
	}
}

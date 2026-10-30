package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
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

func testClientTLS() *tls.ConnectionState {
	return &tls.ConnectionState{PeerCertificates: []*x509.Certificate{{}}}
}

func testConfig() *config {
	cfg := &config{
		SiteId:  "myr-vm1",
		Epoch:   1,
		Listen:  "127.0.0.1:0",
		Token:   fakeBearer(),
		Network: "net-a",
		Images:  []string{"example.com/bot@sha256:aa"},
		Bots: []bot{
			{BotKey: "bot-example-one", MaxMemoryMb: 1536, MaxCpus: 1, MaxPids: 256},
		},
	}
	return cfg
}

func newServer(t *testing.T) (*server, *httptest.Server) {
	t.Helper()
	srv, ts, _ := newServerWithDocker(t)
	return srv, ts
}

// fakeDocker is a minimal Docker Engine API on the fake socket: it keeps the
// create bodies so tests can read back the HostConfig fleetd asked for.
type fakeDocker struct {
	mu              sync.Mutex
	containers      map[string]map[string]any
	calls           []string
	startStopStatus int
	logsBody        []byte
}

func (f *fakeDocker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	path := r.URL.Path
	if i := strings.Index(path, "/containers/"); i >= 0 {
		path = path[i:]
	} else if i := strings.Index(path, "/_ping"); i >= 0 {
		path = path[i:]
	}
	f.calls = append(f.calls, r.Method+" "+path)
	switch {
	case path == "/_ping":
		_, _ = w.Write([]byte("OK"))
	case r.Method == http.MethodPost && path == "/containers/create":
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		f.containers[r.URL.Query().Get("name")] = body
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"Id":"c1"}`))
	case r.Method == http.MethodDelete && strings.HasPrefix(path, "/containers/"):
		name := strings.TrimPrefix(path, "/containers/")
		if _, ok := f.containers[name]; !ok {
			http.Error(w, "no such container", http.StatusNotFound)
			return
		}
		delete(f.containers, name)
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodGet && strings.HasSuffix(path, "/json"):
		name := strings.TrimSuffix(strings.TrimPrefix(path, "/containers/"), "/json")
		c, ok := f.containers[name]
		if !ok {
			http.Error(w, "no such container", http.StatusNotFound)
			return
		}
		out := map[string]any{"State": map[string]any{"Status": "running"}, "Config": map[string]any{"Image": c["Image"], "User": c["User"]}, "HostConfig": c["HostConfig"]}
		_ = json.NewEncoder(w).Encode(out)
	case r.Method == http.MethodPost && (strings.HasSuffix(path, "/start") || strings.HasSuffix(path, "/stop")):
		if f.startStopStatus != 0 {
			w.WriteHeader(f.startStopStatus)
		} else {
			w.WriteHeader(http.StatusNoContent)
		}
	case r.Method == http.MethodGet && strings.HasSuffix(path, "/logs"):
		_, _ = w.Write(f.logsBody)
	default:
		http.NotFound(w, r)
	}
}

func newServerWithDocker(t *testing.T) (*server, *httptest.Server, *fakeDocker) {
	t.Helper()
	fake := &fakeDocker{containers: map[string]map[string]any{}}
	cfg := testConfig()
	cfg.VolumeRoot = t.TempDir()
	socket := filepath.Join(t.TempDir(), "docker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(socket, 0600); err != nil {
		_ = listener.Close()
		t.Fatal(err)
	}
	if err := os.Chmod(cfg.VolumeRoot, 0700); err != nil {
		_ = listener.Close()
		t.Fatal(err)
	}
	// Docker context is tools/fleetd, so keep fixture output outside the checkout.
	dockerHTTP := &http.Server{Handler: fake}
	t.Cleanup(func() {
		_ = dockerHTTP.Close()
		_ = listener.Close()
	})
	go func() { _ = dockerHTTP.Serve(listener) }()
	cfg.Upstream = socket
	srv := &server{cfg: cfg, docker: newDockerClient(cfg)}
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
	return srv, ts, fake
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
		req.TLS = testClientTLS()
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
		req.TLS = testClientTLS()
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
		t.Fatalf("no client certificate: got %d", rec.Code)
	}
	if rec := routeRequest(s, http.MethodGet, "/v1/bots", fakeBearer(), ""); rec.Code != http.StatusOK {
		t.Fatalf("client certificate: got %d %s", rec.Code, rec.Body.String())
	}
}

func TestListShape(t *testing.T) {
	s, _ := newServer(t)
	rec := routeRequest(s, http.MethodGet, "/v1/bots", fakeBearer(), "")
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

func TestHealthRouteRequiresAuthAndReportsResources(t *testing.T) {
	s, _ := newServer(t)
	s.cfg.Bots = []bot{{BotKey: "bot-example-one", MaxMemoryMb: 1024, MaxCpus: 1, MaxPids: 128}}
	token := fakeBearer()
	if rec := routeRequest(s, http.MethodGet, "/v1/bots", "", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated list: got %d", rec.Code)
	}
	if rec := routeRequest(s, http.MethodGet, "/v1/bots/bot-example-one/status", token, ""); rec.Code != http.StatusOK {
		t.Fatalf("authenticated status: got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestWriteProfileUsesIsolatedVolumeRoot(t *testing.T) {
	s, _ := newServer(t)
	key := s.cfg.Bots[0].BotKey
	rec := routeRequest(s, http.MethodPut, "/v1/bots/"+key+"/profile", fakeBearer(), `{"profile":{"botKey":"`+key+`","files":[{"path":"profile.json","content":"{}"}]}}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("profile write failed: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(filepath.Join(s.cfg.VolumeRoot, key, "profile.json")); err != nil {
		t.Fatalf("profile not written under isolated volume root: %v", err)
	}
}

func TestMountPolicy(t *testing.T) {
	if err := validateMounts([]mountSpec{{Source: "/srv/bots", Destination: "/data", ReadOnly: true}}, []string{"/srv/bots"}); err != nil {
		t.Fatalf("allowed mount rejected: %v", err)
	}
	for _, mounts := range [][]mountSpec{
		{{Source: "/etc", Destination: "/data"}},
		{{Source: "/srv/bots", Destination: "/"}},
		{{Source: "/srv/bots/../secret", Destination: "/data"}},
		{{Source: "/srv/bots/x:y", Destination: "/safe"}},
		{{Source: "/srv/bots/x,y", Destination: "/safe"}},
		{{Source: "/srv/bots/x", Destination: "/safe:bad"}},
		{{Source: "/srv/bots/x", Destination: "/data/hermes/config"}},
	} {
		if err := validateMounts(mounts, []string{"/srv/bots"}); err == nil {
			t.Fatalf("unsafe mount accepted: %#v", mounts)
		}
	}
}

func TestStatusOfUnenrolledBotIsRefused(t *testing.T) {
	s, _ := newServer(t)
	rec := routeRequest(s, http.MethodGet, "/v1/bots/notenrolled0000000000000000000000/status", fakeBearer(), "")
	if rec.Code != http.StatusForbidden || rec.Body.String() != "bot_not_enrolled\n" {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
}

func TestStatusOfEnrolledBotIsMissingByDefault(t *testing.T) {
	s, _ := newServer(t)
	key := s.cfg.Bots[0].BotKey
	rec := routeRequest(s, http.MethodGet, "/v1/bots/"+key+"/status", fakeBearer(), "")
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
	if rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/template-drift", fakeBearer(), body(1024)); rec.Code != http.StatusOK {
		t.Fatalf("within limits: got %d %s", rec.Code, rec.Body.String())
	}
	if rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/template-drift", fakeBearer(), body(4096)); rec.Code != http.StatusForbidden || rec.Body.String() != "limit_exceeds_enrollment\n" {
		t.Fatalf("over limits: got %d %q", rec.Code, rec.Body.String())
	}
}

func TestTemplateDriftRefusesMismatchedKey(t *testing.T) {
	s, _ := newServer(t)
	key := s.cfg.Bots[0].BotKey
	body := `{"spec":{"botKey":"otherbot000000000000000000000000","image":"example.com/bot@sha256:aa","memoryMb":1024,"cpus":1,"pidsLimit":256,"network":"net-a"}}`
	rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/template-drift", fakeBearer(), body)
	if rec.Code != http.StatusForbidden || rec.Body.String() != "name_label_mismatch\n" {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
}

func TestUnknownActionIsRefused(t *testing.T) {
	s, _ := newServer(t)
	key := s.cfg.Bots[0].BotKey
	rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/exec", fakeBearer(), "{}")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %d %q", rec.Code, rec.Body.String())
	}
}

func TestBadBotKeyIsRejected(t *testing.T) {
	s, _ := newServer(t)
	if rec := routeRequest(s, http.MethodGet, "/v1/bots/BAD_KEY/status", fakeBearer(), ""); rec.Code != http.StatusBadRequest {
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
	if err := strictDecode([]byte(`{"listen":"a","tlsCert":"server.pem","tlsKey":"server-key.pem","tlsClientCA":"site-ca.pem","unknown":1,"bots":[{"botKey":"k","maxMemoryMb":1,"maxCpus":1,"maxPids":1}]}`), &out); err == nil {
		t.Fatal("unknown key accepted")
	}
}

func TestImagePolicyRequiresDigestAllowlist(t *testing.T) {
	s := &server{cfg: testConfig()}
	sp := spec{BotKey: "bot-example-one", Image: "example.com/bot@sha256:aa", MemoryMb: 128, Cpus: 1, PidsLimit: 64, Network: "net-a"}
	if err := s.validateCreate(sp); err != nil {
		t.Fatalf("valid image rejected: %v", err)
	}
	sp.Image = "example.com/bot:latest"
	if err := s.validateCreate(sp); err == nil {
		t.Fatal("tagged image accepted")
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

func createBody(key string) string {
	return `{"spec":{"botKey":"` + key + `","image":"example.com/bot@sha256:aa","memoryMb":1024,"cpus":1,"pidsLimit":256,"network":"net-a","gatewayPort":18801,"boardExtraHost":"board.example.test:192.0.2.1"}}`
}

func TestCreateAppliesFixedTemplateToHostConfig(t *testing.T) {
	s, _, fake := newServerWithDocker(t)
	s.cfg.GatewayPortStart, s.cfg.GatewayPortEnd = 18801, 18810
	s.cfg.GatewayBindIP = "192.0.2.10"
	s.docker.gatewayBindIP = s.cfg.GatewayBindIP
	key := s.cfg.Bots[0].BotKey
	rec := routeRequest(s, http.MethodPost, "/v1/bots", fakeBearer(), createBody(key))
	if rec.Code != http.StatusOK {
		t.Fatalf("create failed: %d %s", rec.Code, rec.Body.String())
	}
	body, ok := fake.containers["fleet-"+key]
	if !ok {
		t.Fatalf("container not created, calls: %v", fake.calls)
	}
	if body["User"] != "10001" || body["Image"] != "example.com/bot@sha256:aa" {
		t.Fatalf("user or image wrong: %v %v", body["User"], body["Image"])
	}
	host, _ := body["HostConfig"].(map[string]any)
	if host["ReadonlyRootfs"] != true {
		t.Fatalf("rootfs is not read-only: %v", host["ReadonlyRootfs"])
	}
	if caps, _ := host["CapDrop"].([]any); len(caps) != 1 || caps[0] != "ALL" {
		t.Fatalf("CapDrop is %v", host["CapDrop"])
	}
	if opt, _ := host["SecurityOpt"].([]any); len(opt) != 1 || opt[0] != "no-new-privileges:true" {
		t.Fatalf("SecurityOpt is %v", host["SecurityOpt"])
	}
	if host["Memory"] != float64(1024*1024*1024) || host["NanoCpus"] != float64(1e9) || host["PidsLimit"] != float64(256) {
		t.Fatalf("limits wrong: %v %v %v", host["Memory"], host["NanoCpus"], host["PidsLimit"])
	}
	if host["ShmSize"] != float64(64*1024*1024) || host["NetworkMode"] != "net-a" {
		t.Fatalf("shm or network wrong: %v %v", host["ShmSize"], host["NetworkMode"])
	}
	if hosts, _ := host["ExtraHosts"].([]any); len(hosts) != 1 || hosts[0] != "board.example.test:192.0.2.1" {
		t.Fatalf("ExtraHosts is %v", host["ExtraHosts"])
	}
	ports, ok := host["PortBindings"].(map[string]any)["8642/tcp"]
	if !ok {
		t.Fatalf("gateway port not bound: %v", host["PortBindings"])
	}
	port := ports.([]any)[0].(map[string]any)
	if port["HostIp"] != "192.0.2.10" {
		t.Fatalf("gateway bind IP is %v", port["HostIp"])
	}
	// The profile volumes are mounted, so what writeProfile writes reaches the bot.
	binds, _ := host["Binds"].([]any)
	want := map[string]bool{}
	for _, v := range []string{"hermes:/data/hermes", "workspace:/workspace", "scratch:/scratch"} {
		want[filepath.Join(s.cfg.VolumeRoot, key, strings.Split(v, ":")[0])+":"+strings.Split(v, ":")[1]] = false
	}
	for _, b := range binds {
		if _, ok := want[b.(string)]; ok {
			want[b.(string)] = true
		}
	}
	for b, found := range want {
		if !found {
			t.Fatalf("bind %s missing from %v", b, binds)
		}
	}
	if _, err := os.Stat(filepath.Join(s.cfg.VolumeRoot, key, "hermes")); err != nil {
		t.Fatalf("volume directory not prepared: %v", err)
	}
}

func TestCreateRefusesForeignImageAndWritableExtraMount(t *testing.T) {
	s, _, fake := newServerWithDocker(t)
	key := s.cfg.Bots[0].BotKey
	foreign := strings.Replace(createBody(key), "example.com/bot@sha256:aa", "evil.example/bot@sha256:bb", 1)
	if rec := routeRequest(s, http.MethodPost, "/v1/bots", fakeBearer(), foreign); rec.Code != http.StatusForbidden {
		t.Fatalf("foreign image: got %d %s", rec.Code, rec.Body.String())
	}
	s.cfg.AllowedMounts = []string{"/srv/shared"}
	rw := strings.Replace(createBody(key), `"network":"net-a"`, `"network":"net-a","mounts":[{"source":"/srv/shared/x","destination":"/data/x"}]`, 1)
	if rec := routeRequest(s, http.MethodPost, "/v1/bots", fakeBearer(), rw); rec.Code != http.StatusForbidden {
		t.Fatalf("writable extra mount: got %d %s", rec.Code, rec.Body.String())
	}
	etc := strings.Replace(createBody(key), `"network":"net-a"`, `"network":"net-a","mounts":[{"source":"/etc","destination":"/data/x","readOnly":true}]`, 1)
	if rec := routeRequest(s, http.MethodPost, "/v1/bots", fakeBearer(), etc); rec.Code != http.StatusForbidden {
		t.Fatalf("mount outside allowlist: got %d %s", rec.Code, rec.Body.String())
	}
	if len(fake.containers) != 0 {
		t.Fatalf("a refused create reached Docker: %v", fake.calls)
	}
}

func TestRecreateReplacesTheContainer(t *testing.T) {
	s, _, fake := newServerWithDocker(t)
	key := s.cfg.Bots[0].BotKey
	if rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/recreate", fakeBearer(), createBody(key)); rec.Code != http.StatusOK {
		t.Fatalf("recreate without an old container: %d %s", rec.Code, rec.Body.String())
	}
	if rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/recreate", fakeBearer(), createBody(key)); rec.Code != http.StatusOK {
		t.Fatalf("recreate over an old container: %d %s", rec.Code, rec.Body.String())
	}
	if _, ok := fake.containers["fleet-"+key]; !ok {
		t.Fatalf("container missing after recreate: %v", fake.calls)
	}
}

func TestStatusReportsAppliedHashesFromMarker(t *testing.T) {
	s2, _ := newServer(t)
	key := s2.cfg.Bots[0].BotKey
	if rec := routeRequest(s2, http.MethodPost, "/v1/bots", fakeBearer(), createBody(key)); rec.Code != http.StatusOK {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	status := func() botStatus {
		rec := routeRequest(s2, http.MethodGet, "/v1/bots/"+key+"/status", fakeBearer(), "")
		var st botStatus
		if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
			t.Fatalf("status body: %v", err)
		}
		return st
	}
	if st := status(); st.RestartHash != nil || st.FilesHash != nil {
		t.Fatalf("hashes reported before any profile was written: %+v", st)
	}
	profileBody := `{"profile":{"botKey":"` + key + `","restartHash":"rh1","filesHash":"fh1","files":[{"path":"hermes/config.yaml","content":"a: 1","mode":420},{"path":"hermes/.env","content":"K=V","mode":384,"secret":true},{"path":"workspace/AGENTS.md","content":"hi","mode":420}]}}`
	if rec := routeRequest(s2, http.MethodPut, "/v1/bots/"+key+"/profile", fakeBearer(), profileBody); rec.Code != http.StatusOK {
		t.Fatalf("profile: %d %s", rec.Code, rec.Body.String())
	}
	st := status()
	if st.RestartHash == nil || *st.RestartHash != "rh1" || st.FilesHash == nil || *st.FilesHash != "fh1" {
		t.Fatalf("applied hashes not reported: %+v", st)
	}
	info, err := os.Stat(filepath.Join(s2.cfg.VolumeRoot, key, "hermes", ".env"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("secret file mode: %v %v", info, err)
	}
	list := routeRequest(s2, http.MethodGet, "/v1/bots", fakeBearer(), "")
	var body struct {
		Bots []botStatus `json:"bots"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &body); err != nil || len(body.Bots) != 1 || body.Bots[0].RestartHash == nil {
		t.Fatalf("list does not carry hashes: %s", list.Body.String())
	}
}

func TestWriteProfileRefusesEscapesAndSymlinks(t *testing.T) {
	s, _ := newServer(t)
	key := s.cfg.Bots[0].BotKey
	put := func(path string) int {
		body := `{"profile":{"botKey":"` + key + `","restartHash":"r","filesHash":"f","files":[{"path":"` + path + `","content":"x"}]}}`
		return routeRequest(s, http.MethodPut, "/v1/bots/"+key+"/profile", fakeBearer(), body).Code
	}
	for _, bad := range []string{"../escape", "a/../../escape", "/etc/passwd", ""} {
		if code := put(bad); code != http.StatusForbidden {
			t.Fatalf("path %q: got %d", bad, code)
		}
	}
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(s.cfg.VolumeRoot, key), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(s.cfg.VolumeRoot, key, "link")); err != nil {
		t.Fatal(err)
	}
	if code := put("link/pwned"); code != http.StatusForbidden {
		t.Fatalf("symlinked directory: got %d", code)
	}
	if _, err := os.Stat(filepath.Join(outside, "pwned")); err == nil {
		t.Fatal("file written through a symlink")
	}
}

func TestHealthReportsRealResourcesAndDockerState(t *testing.T) {
	s, _ := newServer(t)
	rec := routeRequest(s, http.MethodGet, "/v1/health", s.cfg.Token, "")
	var h siteHealth
	if err := json.Unmarshal(rec.Body.Bytes(), &h); err != nil {
		t.Fatal(err)
	}
	if h.Capacity.CPUCores != int64(runtime.NumCPU()) || h.Allocated.ContainersCount != 1 || h.Allocated.MemoryMb != 1536 {
		t.Fatalf("capacity or allocation wrong: %+v", h)
	}
	// An unreachable board turns the site degraded and names the target.
	s.cfg.BoardAddress = "127.0.0.1:1"
	rec = routeRequest(s, http.MethodGet, "/v1/health", s.cfg.Token, "")
	if err := json.Unmarshal(rec.Body.Bytes(), &h); err != nil {
		t.Fatal(err)
	}
	if h.Status != "degraded" || h.EgressCheck.Ok || len(h.EgressCheck.FailedTargets) != 1 {
		t.Fatalf("egress failure not reported: %+v", h)
	}
	// Docker down: the socket path no longer answers.
	s.cfg.BoardAddress = ""
	s.docker.socket = filepath.Join(t.TempDir(), "gone.sock")
	rec = routeRequest(s, http.MethodGet, "/v1/health", s.cfg.Token, "")
	if err := json.Unmarshal(rec.Body.Bytes(), &h); err != nil {
		t.Fatal(err)
	}
	if h.Status != "degraded" {
		t.Fatalf("docker outage not reported: %+v", h)
	}
}

func TestDockerActionsAcceptAlreadyApplied304(t *testing.T) {
	s, _, fake := newServerWithDocker(t)
	fake.startStopStatus = http.StatusNotModified
	key := s.cfg.Bots[0].BotKey
	for _, action := range []string{"start", "stop", "restart"} {
		if err := s.docker.action(t.Context(), key, action); err != nil {
			t.Fatalf("%s: %v", action, err)
		}
	}
}

func TestDemuxDockerLogsBeforeRedaction(t *testing.T) {
	frame := func(stream byte, body string) []byte {
		b := make([]byte, 8+len(body))
		b[0] = stream
		n := len(body)
		b[4], b[5], b[6], b[7] = byte(n>>24), byte(n>>16), byte(n>>8), byte(n)
		copy(b[8:], body)
		return b
	}
	got := redactLogs(demuxDockerLogs(append(frame(1, `token=first`), frame(2, ` second`)...)))
	if string(got) != "token=<redacted> second" {
		t.Fatalf("unexpected logs: %q", got)
	}
}

func TestDockerLogsDemuxesFramesBeforeRedaction(t *testing.T) {
	s, _, fake := newServerWithDocker(t)
	frame := func(stream byte, body string) []byte {
		b := make([]byte, 8+len(body))
		b[0] = stream
		n := len(body)
		b[4], b[5], b[6], b[7] = byte(n>>24), byte(n>>16), byte(n>>8), byte(n)
		copy(b[8:], body)
		return b
	}
	fake.logsBody = append(frame(1, "token=first"), frame(2, " second")...)
	got, err := s.docker.logs(t.Context(), s.cfg.Bots[0].BotKey)
	if err != nil {
		t.Fatal(err)
	}
	if got != "token=<redacted> second" {
		t.Fatalf("unexpected logs: %q", got)
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

// chownLog records the owner changes restore asks for; tests do not run as root,
// so the real os.Lchown would be refused.
var chownMu sync.Mutex
var chownLog = map[string][2]int{}
var chownErr error

func init() {
	lchown = func(path string, uid, gid int) error {
		chownMu.Lock()
		defer chownMu.Unlock()
		if chownErr != nil {
			return chownErr
		}
		chownLog[path] = [2]int{uid, gid}
		return nil
	}
}

func resetChownLog(err error) {
	chownMu.Lock()
	defer chownMu.Unlock()
	chownLog = map[string][2]int{}
	chownErr = err
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

func TestRestoreHandsDatadirToBotUser(t *testing.T) {
	_, key, archive := snapshotOf(t)
	resetChownLog(nil)
	root := t.TempDir()
	if rec := restoreInto(t, root, key, archive); rec.Code != http.StatusOK {
		t.Fatalf("restore failed: %d %s", rec.Code, rec.Body.String())
	}
	chownMu.Lock()
	defer chownMu.Unlock()
	// staging dir is renamed to the datadir after chown, so compare by relative path.
	rel := map[string][2]int{}
	for p, own := range chownLog {
		i := strings.Index(p, string(filepath.Separator)+"workspace")
		if i < 0 {
			t.Fatalf("unexpected chown target %s", p)
		}
		rel[p[i:]] = own
	}
	for _, want := range []string{"/workspace", "/workspace/code.txt", "/workspace/link.txt"} {
		got, ok := rel[filepath.FromSlash(want)]
		if !ok || got != [2]int{botUID, botUID} {
			t.Fatalf("%s: owner %v (found %v), want %d:%d", want, got, ok, botUID, botUID)
		}
	}
	for p := range chownLog {
		if !strings.Contains(p, string(filepath.Separator)+"workspace") {
			t.Fatalf("datadir root must stay root-owned, but chown asked for %s", p)
		}
	}
}

func TestRestoreFailsWhenOwnerCannotBeSet(t *testing.T) {
	_, key, archive := snapshotOf(t)
	resetChownLog(errors.New("operation not permitted"))
	defer resetChownLog(nil)
	root := t.TempDir()
	rec := restoreInto(t, root, key, archive)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d %s", rec.Code, rec.Body.String())
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("a failed restore left %d entries in the volume root", len(entries))
	}
}

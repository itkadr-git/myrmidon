// tools/fleetd is the fleet service for a second machine (FLEETD-VMEXEC):
// it exposes the board's BotContainerDriver contract over HTTP for bot
// containers that live on its own host, enforcing the same fixed template
// the local driver enforces. Code layout mirrors tools/dockergate (Go,
// standard library only; see docs/myrmidon/fleetd-vmexec.md).
package main

import (
	"archive/tar"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"hash"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// version is set at build time with -ldflags "-X main.version=..." or defaults to 1.6.6.
var version = "1.6.6"

// botStatus is the driver contract's BotContainerStatus.
type botStatus struct {
	BotKey      string  `json:"botKey"`
	State       string  `json:"state"`
	Image       string  `json:"image,omitempty"`
	RestartHash *string `json:"restartHash"`
	FilesHash   *string `json:"filesHash"`
}

// spec is the driver contract's BotContainerSpec.
type spec struct {
	BotKey    string            `json:"botKey"`
	Image     string            `json:"image"`
	MemoryMb  int64             `json:"memoryMb"`
	Cpus      float64           `json:"cpus"`
	PidsLimit int64             `json:"pidsLimit"`
	Network   string            `json:"network"`
	Labels    map[string]string `json:"labels,omitempty"`
}

// profileFile is one file of the compiled profile.
type profileFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mode    int    `json:"mode"`
	Secret  bool   `json:"secret"`
}

// profile is the driver contract's CompiledProfile.
type profile struct {
	BotKey      string        `json:"botKey"`
	Files       []profileFile `json:"files"`
	RestartHash string        `json:"restartHash"`
	FilesHash   string        `json:"filesHash"`
}

type siteCapacity struct {
	CPUCores int64 `json:"cpuCores"`
	MemoryMb int64 `json:"memoryMb"`
	DiskGb   int64 `json:"diskGb"`
}

type egressStatus struct {
	Ok        bool   `json:"ok"`
	Timestamp string `json:"timestamp"`
}

type siteHealth struct {
	SiteId      string       `json:"siteId"`
	Epoch       int64        `json:"epoch"`
	Status      string       `json:"status"`
	Capacity    siteCapacity `json:"capacity"`
	EgressCheck egressStatus `json:"egressCheck"`
	Version     string       `json:"version,omitempty"`
}

// config is the JSON configuration (see docs/myrmidon/fleetd-vmexec.md).
// Unknown keys are rejected at load time, the same discipline as dockergate.
type config struct {
	SiteId     string        `json:"siteId,omitempty"`
	Epoch      int64         `json:"epoch,omitempty"`
	Listen     string        `json:"listen"`
	Token      string        `json:"token"`
	Upstream   string        `json:"upstream"`
	VolumeRoot string        `json:"volumeRoot,omitempty"`
	Bots       []bot         `json:"bots"`
	Memory     *memoryConfig `json:"memory,omitempty"`

	// mTLS material for the site API. All three are set together; serving
	// requires them (requireTLS), --check-config does not.
	SiteCA     string `json:"siteCA,omitempty"`
	ServerCert string `json:"serverCert,omitempty"`
	ServerKey  string `json:"serverKey,omitempty"`
}

type bot struct {
	BotKey      string  `json:"botKey"`
	MaxMemoryMb int64   `json:"maxMemoryMb"`
	MaxCpus     float64 `json:"maxCpus"`
	MaxPids     int64   `json:"maxPids"`
}

// strictDecode decodes data into out and rejects unknown keys.
func strictDecode(data []byte, out any) error {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return err
	}
	if dec.More() {
		return fmt.Errorf("trailing JSON content")
	}
	return nil
}

func main() {
	configPath := flag.String("config", "", "path to the JSON configuration")
	check := flag.Bool("check-config", false, "validate the configuration and exit")
	flag.Parse()
	if *configPath == "" {
		log.Fatal("--config is required")
	}
	raw, err := os.ReadFile(*configPath)
	if err != nil {
		log.Fatalf("read config: %v", err)
	}
	var cfg config
	if err := strictDecode(raw, &cfg); err != nil {
		log.Fatalf("config is invalid: %v", err)
	}
	if err := validate(&cfg); err != nil {
		log.Fatalf("config is invalid: %v", err)
	}
	if *check {
		fmt.Println("configuration is valid")
		return
	}
	if err := requireTLS(&cfg); err != nil {
		log.Fatalf("config is invalid: %v", err)
	}
	tlsConf, err := buildTLSConfig(&cfg)
	if err != nil {
		log.Fatalf("TLS setup failed: %v", err)
	}
	memory, err := newMemoryClient(cfg.Memory)
	if cfg.Memory != nil && cfg.Memory.Enabled && err != nil {
		log.Fatalf("config is invalid: %v", err)
	}
	srv := &server{cfg: &cfg, memory: memory}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", srv.requireAuth(srv.health))
	mux.HandleFunc("/v1/bots", srv.requireAuth(srv.list))
	mux.HandleFunc("/v1/bots/", srv.requireAuth(srv.route))
	mux.HandleFunc("/v1/memory/recall", srv.requireAuth(srv.memoryRecall))
	mux.HandleFunc("/v1/memory/retain", srv.requireAuth(srv.memoryRetain))
	log.Printf("fleetd listening on %s (mTLS)", cfg.Listen)
	log.Fatal((&http.Server{
		Addr:              cfg.Listen,
		Handler:           mux,
		TLSConfig:         tlsConf,
		ReadHeaderTimeout: 5 * time.Second,
	}).ListenAndServeTLS("", ""))
}

// requireTLS is the serving-time check: the site API is mTLS-only, so the CA
// and the server key pair must be configured, absolute and readable.
func requireTLS(cfg *config) error {
	if cfg.SiteCA == "" || cfg.ServerCert == "" || cfg.ServerKey == "" {
		return fmt.Errorf("siteCA, serverCert and serverKey are required")
	}
	return checkTLSPaths(cfg)
}

// checkTLSPaths rejects a partial TLS block and non-absolute paths.
func checkTLSPaths(cfg *config) error {
	set := 0
	for _, p := range []string{cfg.SiteCA, cfg.ServerCert, cfg.ServerKey} {
		if p != "" {
			set++
		}
	}
	if set == 0 {
		return nil
	}
	if set != 3 {
		return fmt.Errorf("siteCA, serverCert and serverKey must be set together")
	}
	for name, p := range map[string]string{"siteCA": cfg.SiteCA, "serverCert": cfg.ServerCert, "serverKey": cfg.ServerKey} {
		if !filepath.IsAbs(p) {
			return fmt.Errorf("%s path must be absolute", name)
		}
	}
	return nil
}

// buildTLSConfig returns a server config that demands a client certificate
// signed by the site CA. Errors carry no key material.
func buildTLSConfig(cfg *config) (*tls.Config, error) {
	pair, err := tls.LoadX509KeyPair(cfg.ServerCert, cfg.ServerKey)
	if err != nil {
		return nil, fmt.Errorf("load server certificate")
	}
	caPEM, err := os.ReadFile(cfg.SiteCA)
	if err != nil {
		return nil, fmt.Errorf("read site CA")
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("site CA contains no certificates")
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{pair},
		ClientCAs:    pool,
		ClientAuth:   tls.RequireAndVerifyClientCert,
	}, nil
}

func validate(cfg *config) error {
	if cfg.SiteId == "" {
		cfg.SiteId = "fleetd-local"
	} else if !validSiteId(cfg.SiteId) {
		return fmt.Errorf("siteId %q is invalid (must match [a-z0-9-])", cfg.SiteId)
	}
	if cfg.Epoch < 0 {
		return fmt.Errorf("epoch must be non-negative")
	}
	if cfg.Epoch == 0 {
		cfg.Epoch = 1
	}
	if cfg.Listen == "" {
		return fmt.Errorf("listen is required (host:port)")
	}
	if len(cfg.Token) < 32 {
		return fmt.Errorf("token must be at least 32 characters")
	}
	if err := checkTLSPaths(cfg); err != nil {
		return err
	}
	if cfg.Upstream == "" {
		cfg.Upstream = "/var/run/docker.sock"
	}
	if len(cfg.Bots) == 0 {
		return fmt.Errorf("at least one bots[] entry is required")
	}
	for i := range cfg.Bots {
		b := &cfg.Bots[i]
		if b.BotKey == "" || !validBotKey(b.BotKey) {
			return fmt.Errorf("bots[%d].botKey %q is invalid", i, b.BotKey)
		}
		if b.MaxMemoryMb <= 0 || b.MaxCpus <= 0 || b.MaxPids <= 0 {
			return fmt.Errorf("bots[%d] limits must be positive", i)
		}
	}
	if cfg.Memory != nil && cfg.Memory.Enabled {
		if _, err := newMemoryClient(cfg.Memory); err != nil {
			return err
		}
	}
	return nil
}

func validSiteId(id string) bool {
	if len(id) < 1 || len(id) > 63 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return id[0] != '-' && id[len(id)-1] != '-'
}

func validBotKey(key string) bool {
	if len(key) < 1 || len(key) > 63 {
		return false
	}
	for i := 0; i < len(key); i++ {
		c := key[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return c(key[0]) != '-' && c(key[len(key)-1]) != '-'
}

type c byte

func (c c) in(set string) bool { return strings.ContainsRune(set, rune(c)) }

// server holds the per-request state. The memory client is optional and has
// no host filesystem dependency.
type server struct {
	cfg    *config
	memory *memoryClient
}

func (s *server) memoryRecall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.memory == nil {
		http.Error(w, "centralized_memory_disabled", http.StatusServiceUnavailable)
		return
	}
	var req memoryRecallRequest
	if err := decodeMemoryBody(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	data, err := s.memory.recall(r.Context(), req.Query, req.Budget, req.MaxTokens)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeRawJSON(w, data)
}

func (s *server) memoryRetain(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.memory == nil {
		http.Error(w, "centralized_memory_disabled", http.StatusServiceUnavailable)
		return
	}
	var req memoryRetainRequest
	if err := decodeMemoryBody(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	data, err := s.memory.retain(r.Context(), req.Content, req.Context, req.DocumentID, req.Metadata)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeRawJSON(w, data)
}

func writeRawJSON(w http.ResponseWriter, data []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// requireAuth wraps a handler with the static bearer token check.
func (s *server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		const prefix = "Bearer "
		if len(auth) <= len(prefix) || auth[:len(prefix)] != prefix || auth[len(prefix):] != s.cfg.Token {
			http.Error(w, "invalid_token", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// health answers GET /v1/health.
func (s *server) health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed)
		return
	}
	var totalMem int64
	var totalCpus float64
	for i := range s.cfg.Bots {
		totalMem += s.cfg.Bots[i].MaxMemoryMb
		totalCpus += s.cfg.Bots[i].MaxCpus
	}
	h := siteHealth{
		SiteId: s.cfg.SiteId,
		Epoch:  s.cfg.Epoch,
		Status: "healthy",
		Capacity: siteCapacity{
			CPUCores: int64(totalCpus) + 1,
			MemoryMb: totalMem + 1024,
			DiskGb:   100,
		},
		EgressCheck: egressStatus{
			Ok:        true,
			Timestamp: time.Now().UTC().Format(time.RFC3339),
		},
		Version: version,
	}
	writeJSON(w, h)
}

// list answers GET /v1/bots.
func (s *server) list(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, map[string]any{"bots": []botStatus{}})
}

// route dispatches /v1/bots/{botKey}/... by method and suffix.
func (s *server) route(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/bots/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) == 0 || !validBotKey(parts[0]) {
		http.Error(w, "bad_bot_key", http.StatusBadRequest)
		return
	}
	botKey := parts[0]
	if len(parts) == 1 {
		http.Error(w, "route_not_allowed", http.StatusForbidden)
		return
	}
	action := parts[1]
	if !s.enrolled(botKey) {
		http.Error(w, "bot_not_enrolled", http.StatusForbidden)
		return
	}
	switch {
	case action == "status" && r.Method == http.MethodGet:
		writeJSON(w, botStatus{BotKey: botKey, State: "missing"})
	case action == "template-drift" && r.Method == http.MethodPost:
		var body struct {
			Spec spec `json:"spec"`
		}
		if err := decodeBody(r, &body); err != nil {
			http.Error(w, "body_not_allowed", http.StatusBadRequest)
			return
		}
		if err := s.checkSpec(botKey, &body.Spec); err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		writeJSON(w, map[string]bool{"drift": false})
	case action == "snapshot" && r.Method == http.MethodPost:
		s.handleSnapshot(w, r, botKey)
	case action == "restore" && r.Method == http.MethodPost:
		s.handleRestore(w, r, botKey)
	case action == "quarantine" && r.Method == http.MethodPost:
		s.handleQuarantine(w, r, botKey)
	default:
		if r.Method == http.MethodPost || r.Method == http.MethodPut {
			http.Error(w, "route_not_allowed", http.StatusForbidden)
			return
		}
		http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed)
	}
}

func (s *server) volumeRoot() string {
	if s.cfg.VolumeRoot != "" {
		return s.cfg.VolumeRoot
	}
	return "/srv/myrmidon-bots"
}

// snapshotManifestName is the last entry of every snapshot archive. It is
// written only after the whole datadir was archived, so an archive without it
// is a snapshot that broke off, and restore refuses it.
const snapshotManifestName = ".fleetd-snapshot-manifest"

// snapshotManifest describes the archived datadir: the number of entries, the
// total size of the regular files and a SHA-256 over names, sizes, link targets
// and file contents in archive order. Restore recomputes it from what it
// actually extracted.
type snapshotManifest struct {
	Version int    `json:"version"`
	Entries int64  `json:"entries"`
	Bytes   int64  `json:"bytes"`
	SHA256  string `json:"sha256"`
}

type manifestHasher struct {
	h       hash.Hash
	entries int64
	bytes   int64
}

func newManifestHasher() *manifestHasher {
	return &manifestHasher{h: sha256.New()}
}

// entry records one archive entry; file contents are fed to m.h by the caller
// right after the entry.
func (m *manifestHasher) entry(kind byte, name string, size int64, link string) {
	fmt.Fprintf(m.h, "%c\x00%s\x00%d\x00%s\x00", kind, name, size, link)
	m.entries++
	m.bytes += size
}

func (m *manifestHasher) manifest() snapshotManifest {
	return snapshotManifest{
		Version: 1,
		Entries: m.entries,
		Bytes:   m.bytes,
		SHA256:  hex.EncodeToString(m.h.Sum(nil)),
	}
}

// abortResponse breaks off the response without a proper end: the client sees a
// failed transfer, not a snapshot that merely looks complete. A variable so a
// test can observe the call.
var abortResponse = func() {
	panic(http.ErrAbortHandler)
}

// writeSnapshot streams the datadir as a tar inside a zstd frame (raw blocks,
// no compression yet) followed by the manifest entry. On any error it returns
// at once WITHOUT closing the tar and zstd writers, so the stream never ends
// in a valid-looking footer.
func writeSnapshot(out io.Writer, dir string) error {
	zw := newZstdRawWriter(out)
	tw := tar.NewWriter(zw)
	mh := newManifestHasher()

	err := filepath.Walk(dir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		name := filepath.ToSlash(rel)
		if name == snapshotManifestName {
			return fmt.Errorf("datadir contains the reserved entry %q", name)
		}
		mode := info.Mode()
		link := ""
		switch {
		case mode.IsRegular() || mode.IsDir():
		case mode&os.ModeSymlink != 0:
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			link = target
		case mode&(os.ModeSocket|os.ModeNamedPipe) != 0:
			// Runtime endpoints carry no state; they are not archived.
			log.Printf("snapshot: skipping %s (%s)", name, mode.Type())
			return nil
		default:
			return fmt.Errorf("unsupported file type %s at %s", mode.Type(), name)
		}
		hdr, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		hdr.Name = name
		hdr.Uid = 10001
		hdr.Gid = 10001
		hdr.Uname = ""
		hdr.Gname = ""
		switch {
		case mode.IsDir():
			mh.entry('d', name, 0, "")
		case link != "":
			mh.entry('l', name, 0, link)
		default:
			mh.entry('f', name, hdr.Size, "")
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if !mode.IsRegular() {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		n, err := io.Copy(io.MultiWriter(tw, mh.h), f)
		if err != nil {
			return err
		}
		if n != hdr.Size {
			return fmt.Errorf("%s changed while archived: %d of %d bytes", name, n, hdr.Size)
		}
		return nil
	})
	if err != nil {
		return err
	}

	body, err := json.Marshal(mh.manifest())
	if err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{
		Name:     snapshotManifestName,
		Typeflag: tar.TypeReg,
		Mode:     0600,
		Size:     int64(len(body)),
		Uid:      10001,
		Gid:      10001,
	}); err != nil {
		return err
	}
	if _, err := tw.Write(body); err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return zw.Close()
}

func (s *server) handleSnapshot(w http.ResponseWriter, r *http.Request, botKey string) {
	dir := filepath.Join(s.volumeRoot(), botKey)
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		http.Error(w, "datadir_not_found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/x-tar+zstd")
	if err := writeSnapshot(w, dir); err != nil {
		log.Printf("snapshot error for %s: %v", botKey, err)
		abortResponse()
	}
}

// checkNoSymlinkParents refuses to write below a symlink: restore creates
// links as plain entries and must never follow one.
func checkNoSymlinkParents(root, target string) error {
	rel, err := filepath.Rel(root, filepath.Dir(target))
	if err != nil {
		return err
	}
	if rel == "." {
		return nil
	}
	cur := root
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		cur = filepath.Join(cur, part)
		fi, err := os.Lstat(cur)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("path_through_symlink_denied")
		}
	}
	return nil
}

// extractSnapshot unpacks the archive into the empty directory dir and checks
// it against the manifest. It returns the HTTP status for a failure.
func extractSnapshot(src io.Reader, dir string) (int, error) {
	tr := tar.NewReader(src)
	mh := newManifestHasher()
	var manifest *snapshotManifest

	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return http.StatusBadRequest, fmt.Errorf("invalid archive: %v", err)
		}
		if manifest != nil {
			return http.StatusBadRequest, fmt.Errorf("invalid archive: entries after the manifest")
		}
		if hdr.Name == snapshotManifestName {
			body, err := io.ReadAll(io.LimitReader(tr, 1<<20))
			if err != nil {
				return http.StatusBadRequest, fmt.Errorf("invalid archive: %v", err)
			}
			var m snapshotManifest
			if err := json.Unmarshal(body, &m); err != nil {
				return http.StatusBadRequest, fmt.Errorf("invalid manifest: %v", err)
			}
			manifest = &m
			continue
		}

		clean := filepath.Clean(filepath.FromSlash(hdr.Name))
		if clean == "." || clean == ".." || filepath.IsAbs(clean) ||
			strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return http.StatusBadRequest, fmt.Errorf("path_traversal_denied")
		}
		name := filepath.ToSlash(clean)
		target := filepath.Join(dir, clean)
		if err := checkNoSymlinkParents(dir, target); err != nil {
			return http.StatusBadRequest, err
		}

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, hdr.FileInfo().Mode().Perm()|0700); err != nil {
				return http.StatusInternalServerError, fmt.Errorf("mkdir failed: %v", err)
			}
			mh.entry('d', name, 0, "")
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return http.StatusInternalServerError, fmt.Errorf("mkdir parent failed: %v", err)
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, hdr.FileInfo().Mode().Perm())
			if err != nil {
				return http.StatusInternalServerError, fmt.Errorf("create file failed: %v", err)
			}
			mh.entry('f', name, hdr.Size, "")
			n, err := io.Copy(io.MultiWriter(f, mh.h), tr)
			closeErr := f.Close()
			if err != nil {
				return http.StatusBadRequest, fmt.Errorf("write file failed: %v", err)
			}
			if closeErr != nil {
				return http.StatusInternalServerError, fmt.Errorf("close file failed: %v", closeErr)
			}
			if n != hdr.Size {
				return http.StatusBadRequest, fmt.Errorf("short file %s: %d of %d bytes", name, n, hdr.Size)
			}
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return http.StatusInternalServerError, fmt.Errorf("mkdir parent failed: %v", err)
			}
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return http.StatusInternalServerError, fmt.Errorf("symlink failed: %v", err)
			}
			mh.entry('l', name, 0, hdr.Linkname)
		default:
			// Hard links are not produced by snapshot (they are archived as
			// separate files) and devices are never valid in a bot datadir.
			return http.StatusBadRequest, fmt.Errorf("unsupported entry type %d for %s", hdr.Typeflag, name)
		}
	}

	if manifest == nil {
		return http.StatusBadRequest, fmt.Errorf("incomplete snapshot: manifest missing")
	}
	got := mh.manifest()
	if manifest.Version != got.Version || manifest.Entries != got.Entries ||
		manifest.Bytes != got.Bytes || manifest.SHA256 != got.SHA256 {
		return http.StatusBadRequest, fmt.Errorf(
			"snapshot verification failed: manifest %d entries/%d bytes, extracted %d entries/%d bytes",
			manifest.Entries, manifest.Bytes, got.Entries, got.Bytes)
	}
	return http.StatusOK, nil
}

// botUID is the uid/gid the bot container runs as (BOT_CONTAINER_UID on the board).
const botUID = 10001

// lchown is replaceable in tests (they do not run as root).
var lchown = os.Lchown

// chownTree gives every entry below root (not root itself) to the bot user.
// fleetd runs as root, so without this a restored datadir would be root-owned
// with 0600/0700 modes and the bot could not read its sessions. The datadir root
// stays root-owned, as the volume rules require; Lchown never follows symlinks.
func chownTree(root string) error {
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == root {
			return nil
		}
		return lchown(path, botUID, botUID)
	})
}

// handleRestore unpacks into a staging directory next to the datadir and swaps
// it in only after the archive passed verification. An existing datadir is
// renamed aside (".replaced-<bot>-<ts>"), never merged into, so no stale file
// of an older state survives and a failed restore changes nothing.
func (s *server) handleRestore(w http.ResponseWriter, r *http.Request, botKey string) {
	root := s.volumeRoot()
	if err := os.MkdirAll(root, 0700); err != nil {
		http.Error(w, fmt.Sprintf("cannot create volume root: %v", err), http.StatusInternalServerError)
		return
	}
	stamp := time.Now().UnixNano()
	staging := filepath.Join(root, fmt.Sprintf(".restore-%s-%d", botKey, stamp))
	if err := os.Mkdir(staging, 0700); err != nil {
		http.Error(w, fmt.Sprintf("cannot create staging dir: %v", err), http.StatusInternalServerError)
		return
	}

	if status, err := extractSnapshot(newZstdRawReader(r.Body), staging); err != nil {
		_ = os.RemoveAll(staging)
		http.Error(w, err.Error(), status)
		return
	}
	if err := chownTree(staging); err != nil {
		_ = os.RemoveAll(staging)
		http.Error(w, fmt.Sprintf("cannot hand the restored datadir to the bot user: %v", err), http.StatusInternalServerError)
		return
	}

	dir := filepath.Join(root, botKey)
	if _, err := os.Lstat(dir); err == nil {
		aside := filepath.Join(root, fmt.Sprintf(".replaced-%s-%d", botKey, stamp))
		if err := os.Rename(dir, aside); err != nil {
			_ = os.RemoveAll(staging)
			http.Error(w, fmt.Sprintf("cannot move the old datadir aside: %v", err), http.StatusInternalServerError)
			return
		}
	}
	if err := os.Rename(staging, dir); err != nil {
		_ = os.RemoveAll(staging)
		http.Error(w, fmt.Sprintf("cannot put the restored datadir in place: %v", err), http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]string{"status": "restored"})
}

func (s *server) handleQuarantine(w http.ResponseWriter, r *http.Request, botKey string) {
	dir := filepath.Join(s.volumeRoot(), botKey)
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		writeJSON(w, map[string]string{"status": "quarantined"})
		return
	}

	target := filepath.Join(s.volumeRoot(), fmt.Sprintf(".quarantined-%s-%d", botKey, time.Now().Unix()))
	if err := os.Rename(dir, target); err != nil {
		http.Error(w, fmt.Sprintf("quarantine rename failed: %v", err), http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]string{"status": "quarantined", "path": target})
}

func (s *server) enrolled(botKey string) bool {
	for i := range s.cfg.Bots {
		if s.cfg.Bots[i].BotKey == botKey {
			return true
		}
	}
	return false
}

// checkSpec enforces the enrolled limits for the bot (a full create-body
// policy lands with the Docker wiring; the limits check is the seam).
func (s *server) checkSpec(botKey string, sp *spec) error {
	if sp.BotKey != botKey {
		return fmt.Errorf("name_label_mismatch")
	}
	for i := range s.cfg.Bots {
		b := &s.cfg.Bots[i]
		if b.BotKey != botKey {
			continue
		}
		if sp.MemoryMb > b.MaxMemoryMb {
			return fmt.Errorf("limit_exceeds_enrollment")
		}
		if sp.Cpus > b.MaxCpus {
			return fmt.Errorf("limit_exceeds_enrollment")
		}
		if sp.PidsLimit > b.MaxPids {
			return fmt.Errorf("limit_exceeds_enrollment")
		}
		return nil
	}
	return fmt.Errorf("bot_not_enrolled")
}

func decodeBody(r *http.Request, out any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(out)
}

func writeJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

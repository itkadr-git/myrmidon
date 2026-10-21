// tools/fleetd is the fleet service for a second machine (FLEETD-VMEXEC):
// it exposes the board's BotContainerDriver contract over HTTP for bot
// containers that live on its own host, enforcing the same fixed template
// the local driver enforces. Code layout mirrors tools/dockergate (Go,
// standard library only; see docs/myrmidon/fleetd-vmexec.md).
package main

import (
	"archive/tar"
	"encoding/json"
	"flag"
	"fmt"
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
	memory, err := newMemoryClient(cfg.Memory)
	if cfg.Memory != nil && cfg.Memory.Enabled && err != nil {
		log.Fatalf("config is invalid: %v", err)
	}
	srv := &server{cfg: &cfg, memory: memory}
	http.HandleFunc("/v1/health", srv.requireAuth(srv.health))
	http.HandleFunc("/v1/bots", srv.requireAuth(srv.list))
	http.HandleFunc("/v1/bots/", srv.requireAuth(srv.route))
	http.HandleFunc("/v1/memory/recall", srv.requireAuth(srv.memoryRecall))
	http.HandleFunc("/v1/memory/retain", srv.requireAuth(srv.memoryRetain))
	log.Printf("fleetd listening on %s", cfg.Listen)
	log.Fatal(http.ListenAndServe(cfg.Listen, nil))
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

func (s *server) handleSnapshot(w http.ResponseWriter, r *http.Request, botKey string) {
	dir := filepath.Join(s.volumeRoot(), botKey)
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		http.Error(w, "datadir_not_found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/x-tar+zstd")
	zw := newZstdRawWriter(w)
	defer zw.Close()

	tw := tar.NewWriter(zw)
	defer tw.Close()

	err = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = filepath.ToSlash(rel)
		hdr.Uid = 10001
		hdr.Gid = 10001
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(tw, f)
		return err
	})
	if err != nil {
		log.Printf("snapshot error for %s: %v", botKey, err)
	}
}

func (s *server) handleRestore(w http.ResponseWriter, r *http.Request, botKey string) {
	dir := filepath.Join(s.volumeRoot(), botKey)
	if err := os.MkdirAll(dir, 0700); err != nil {
		http.Error(w, fmt.Sprintf("cannot create datadir: %v", err), http.StatusInternalServerError)
		return
	}

	zr := newZstdRawReader(r.Body)
	tr := tar.NewReader(zr)

	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			http.Error(w, fmt.Sprintf("invalid archive: %v", err), http.StatusBadRequest)
			return
		}

		clean := filepath.Clean(hdr.Name)
		if strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) {
			http.Error(w, "path_traversal_denied", http.StatusBadRequest)
			return
		}

		target := filepath.Join(dir, clean)
		if hdr.FileInfo().IsDir() {
			if err := os.MkdirAll(target, hdr.FileInfo().Mode()); err != nil {
				http.Error(w, fmt.Sprintf("mkdir failed: %v", err), http.StatusInternalServerError)
				return
			}
			continue
		}

		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			http.Error(w, fmt.Sprintf("mkdir parent failed: %v", err), http.StatusInternalServerError)
			return
		}

		f, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, hdr.FileInfo().Mode())
		if err != nil {
			http.Error(w, fmt.Sprintf("create file failed: %v", err), http.StatusInternalServerError)
			return
		}
		if _, err := io.Copy(f, tr); err != nil {
			f.Close()
			http.Error(w, fmt.Sprintf("write file failed: %v", err), http.StatusInternalServerError)
			return
		}
		f.Close()
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

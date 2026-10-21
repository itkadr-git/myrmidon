package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

func (s *server) validateCreate(sp spec) error {
	if sp.Image == "" || !strings.Contains(sp.Image, "@sha256:") {
		return errForbidden("image_digest_required")
	}
	if !s.imageAllowed(sp.Image) {
		return errForbidden("image_not_allowed")
	}
	if sp.Network != s.cfg.Network {
		return errForbidden("network_not_allowed")
	}
	if sp.MemoryMb <= 0 || sp.Cpus <= 0 || sp.PidsLimit <= 0 {
		return errForbidden("limits_invalid")
	}
	b := s.enrollment(sp.BotKey)
	if b == nil || sp.MemoryMb > b.MaxMemoryMb || sp.Cpus > b.MaxCpus || sp.PidsLimit > b.MaxPids {
		return errForbidden("limits_exceeded")
	}
	for _, mount := range sp.Mounts {
		if !mount.ReadOnly {
			return errForbidden("mount_not_allowed")
		}
	}
	return nil
}

type apiError struct {
	status int
	reason string
}

func (e *apiError) Error() string { return e.reason }

func errForbidden(reason string) error {
	return &apiError{status: http.StatusForbidden, reason: reason}
}

func errConflict(reason string) error { return &apiError{status: http.StatusConflict, reason: reason} }

func (s *server) imageAllowed(image string) bool {
	if !strings.Contains(image, "@sha256:") {
		return false
	}
	for _, allowed := range s.cfg.Images {
		prefix, _, ok := strings.Cut(allowed, "*")
		if (ok && strings.HasPrefix(image, prefix)) || (!ok && image == allowed) {
			return true
		}
	}
	return false
}

// botVolumes are the per-bot directories under volumeRoot/<botKey> that the
// compiled profile is written into and that the container sees at the same
// paths the local driver uses (template.ts BOT_VOLUME_MOUNTS).
var botVolumes = []struct{ suffix, containerPath string }{
	{"hermes", "/data/hermes"},
	{"workspace", "/workspace"},
	{"scratch", "/scratch"},
}

const botUID = 10001

// binds returns the Docker bind list for a container: the bot's own volume
// directories (read-write, so the profile written by writeProfile reaches the
// container) and the extra mounts, which are always read-only. It has no side
// effects: drift checks call it too.
func (s *server) binds(sp spec) ([]string, error) {
	if s.cfg.VolumeRoot == "" {
		return nil, errForbidden("volume_root_not_configured")
	}
	root := filepath.Join(s.cfg.VolumeRoot, sp.BotKey)
	binds := make([]string, 0, len(botVolumes)+len(sp.Mounts))
	for _, v := range botVolumes {
		binds = append(binds, filepath.Join(root, v.suffix)+":"+v.containerPath)
	}
	for _, mount := range sp.Mounts {
		if !mount.ReadOnly {
			return nil, errForbidden("mount_not_allowed")
		}
		binds = append(binds, mount.Source+":"+mount.Destination+":ro")
	}
	return binds, nil
}

// prepareVolumes creates the bot's volume directories (0700, owned by the
// container user when fleetd may chown) before the container is created.
func (s *server) prepareVolumes(botKey string) error {
	root := filepath.Join(s.cfg.VolumeRoot, botKey)
	for _, v := range botVolumes {
		dir := filepath.Join(root, v.suffix)
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		_ = os.Chown(dir, botUID, botUID) // best effort: fleetd may run unprivileged
	}
	return nil
}

// createFromSpec is the single create path of POST /v1/bots, .../create and
// .../recreate: policy checks, gateway port, volumes, then Docker. It returns
// the HTTP status to answer with when it fails.
func (s *server) createFromSpec(ctx context.Context, botKey string, sp *spec, replace bool) (int, error) {
	if err := s.checkSpec(botKey, sp); err != nil {
		return http.StatusForbidden, err
	}
	if err := s.applyGatewayPort(sp); err != nil {
		return http.StatusConflict, err
	}
	binds, err := s.binds(*sp)
	if err != nil {
		return http.StatusForbidden, err
	}
	if err := s.prepareVolumes(botKey); err != nil {
		return http.StatusInternalServerError, fmt.Errorf("volume_prepare_failed")
	}
	if replace {
		if err := s.docker.remove(ctx, botKey); err != nil && !strings.Contains(err.Error(), "404") {
			return http.StatusBadGateway, err
		}
	}
	if err := s.docker.create(ctx, *sp, binds); err != nil {
		return http.StatusBadGateway, err
	}
	return http.StatusOK, nil
}

func validateMounts(mounts []mountSpec, allowed []string) error {
	for _, m := range mounts {
		if m.Source == "" || m.Destination == "" || !filepath.IsAbs(m.Destination) || m.Destination == "/" {
			return fmt.Errorf("mount_invalid")
		}
		if filepath.Clean(m.Destination) != m.Destination || strings.Contains(m.Source, "..") {
			return fmt.Errorf("mount_invalid")
		}
		ok := false
		for _, root := range allowed {
			if m.Source == root || strings.HasPrefix(m.Source, strings.TrimSuffix(root, "/")+"/") {
				ok = true
				break
			}
		}
		if !ok {
			return fmt.Errorf("mount_not_allowed")
		}
	}
	return nil
}

func (s *server) enrollment(key string) *bot {
	for i := range s.cfg.Bots {
		if s.cfg.Bots[i].BotKey == key {
			return &s.cfg.Bots[i]
		}
	}
	return nil
}
func (s *server) allocatePort(key string) (int, error) {
	used := map[int]bool{}
	for _, b := range s.cfg.Bots {
		if b.GatewayPort != 0 && b.BotKey != key {
			used[b.GatewayPort] = true
		}
		if b.BotKey != key {
			if x, ok, _ := s.inspect(context.Background(), b.BotKey); ok {
				if p := x.HostConfig.PortBindings["8642/tcp"]; len(p) > 0 {
					if n, e := strconvPort(p[0].HostPort); e == nil {
						used[n] = true
					}
				}
			}
		}
	}
	if x, ok, _ := s.inspect(context.Background(), key); ok {
		if p := x.HostConfig.PortBindings["8642/tcp"]; len(p) > 0 {
			if n, e := strconvPort(p[0].HostPort); e == nil {
				return n, nil
			}
		}
	}
	for p := s.cfg.GatewayPortStart; p <= s.cfg.GatewayPortEnd; p++ {
		if !used[p] {
			return p, nil
		}
	}
	return 0, fmt.Errorf("gateway_port_exhausted")
}

func (s *server) gatewayPort(key string) int {
	if b := s.enrollment(key); b != nil && b.GatewayPort != 0 {
		return b.GatewayPort
	}
	x, ok, _ := s.inspect(context.Background(), key)
	if ok && len(x.HostConfig.PortBindings["8642/tcp"]) > 0 {
		p, _ := strconvPort(x.HostConfig.PortBindings["8642/tcp"][0].HostPort)
		return p
	}
	return 0
}

func (s *server) applyGatewayPort(sp *spec) error {
	if sp.GatewayPort != 0 {
		return nil
	}
	p, err := s.allocatePort(sp.BotKey)
	if err != nil {
		return err
	}
	sp.GatewayPort = p
	if sp.BoardExtraHost == "" {
		sp.BoardExtraHost = s.cfg.BoardExtraHost
	}
	return nil
}

// markerRelativePath is where the applied-state marker lives, relative to the
// bot's volume root; the same file name the local driver uses, inside hermes.
const markerRelativePath = "hermes/.myrmidon/applied.json"

// appliedMarker is what a successful writeProfile leaves behind, so status can
// report which profile hashes are on disk.
type appliedMarker struct {
	RestartHash string   `json:"restartHash"`
	FilesHash   string   `json:"filesHash"`
	Files       []string `json:"files"`
}

// writeProfile is the only place profile files are written. Paths are relative
// to volumeRoot/<botKey> (for example hermes/config.yaml, workspace/AGENTS.md),
// may not leave it, and may not pass through a symlink (the volume is writable
// by the bot). The applied marker is written last.
func (s *server) writeProfile(p profile) error {
	if !validBotKey(p.BotKey) {
		return errForbidden("bad_bot_key")
	}
	if s.cfg.VolumeRoot == "" {
		return errForbidden("volume_root_not_configured")
	}
	root := filepath.Join(s.cfg.VolumeRoot, p.BotKey)
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	paths := make([]string, 0, len(p.Files))
	for _, f := range p.Files {
		slash := filepath.ToSlash(f.Path)
		if f.Path == "" || filepath.IsAbs(f.Path) || slash == ".." || strings.HasPrefix(slash, "../") || strings.Contains(slash, "/../") {
			return errForbidden("profile_path_invalid")
		}
		if err := s.writeProfileFile(realRoot, f); err != nil {
			return err
		}
		paths = append(paths, slash)
	}
	sort.Strings(paths)
	marker, err := json.Marshal(appliedMarker{RestartHash: p.RestartHash, FilesHash: p.FilesHash, Files: paths})
	if err != nil {
		return err
	}
	return s.writeProfileFile(realRoot, profileFile{Path: markerRelativePath, Content: string(marker) + "\n", Mode: 0600, Secret: true})
}

func (s *server) writeProfileFile(realRoot string, f profileFile) error {
	target := filepath.Join(realRoot, filepath.Clean(f.Path))
	if rel, e := filepath.Rel(realRoot, target); e != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return errForbidden("profile_path_invalid")
	}
	dir := filepath.Dir(target)
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	// The directory chain must resolve inside the root, and the file itself
	// must not be a symlink.
	realDir, e := filepath.EvalSymlinks(dir)
	if e != nil {
		return e
	}
	if rel, e := filepath.Rel(realRoot, realDir); e != nil || strings.HasPrefix(rel, "..") {
		return errForbidden("profile_path_invalid")
	}
	if fi, e := os.Lstat(target); e == nil && fi.Mode()&os.ModeSymlink != 0 {
		return errForbidden("profile_path_invalid")
	}
	mode := os.FileMode(f.Mode) & 0777
	if f.Secret || mode == 0 {
		mode = 0600
	}
	// Write to a temporary name and rename, so a reader never sees half a file.
	tmp, e := os.CreateTemp(realDir, ".fleetd-*")
	if e != nil {
		return e
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, e = tmp.WriteString(f.Content); e != nil {
		_ = tmp.Close()
		return e
	}
	if e = tmp.Close(); e != nil {
		return e
	}
	if e = os.Chmod(tmpName, mode); e != nil {
		return e
	}
	_ = os.Chown(tmpName, botUID, botUID) // best effort: fleetd may run unprivileged
	_ = os.Chown(dir, botUID, botUID)
	return os.Rename(tmpName, target)
}

// fillApplied sets the applied profile hashes of a status from the marker.
// A missing container, a missing marker or an unreadable one leave them nil:
// the board then reads "nothing verified applied" and plans a restart.
func (s *server) fillApplied(st *botStatus) {
	if st.State == "missing" || s.cfg.VolumeRoot == "" || !validBotKey(st.BotKey) {
		return
	}
	raw, err := os.ReadFile(filepath.Join(s.cfg.VolumeRoot, st.BotKey, markerRelativePath))
	if err != nil || len(raw) > 64*1024 {
		return
	}
	// The marker lives on a volume the bot can write: it is data, not trusted state.
	var m appliedMarker
	if json.Unmarshal(raw, &m) != nil || m.RestartHash == "" || m.FilesHash == "" || len(m.RestartHash) > 128 || len(m.FilesHash) > 128 {
		return
	}
	st.RestartHash, st.FilesHash = &m.RestartHash, &m.FilesHash
}

var secretPattern = regexp.MustCompile(`(?i)(["']?(?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^\s"']+`)

func redactLogs(b []byte) []byte { return secretPattern.ReplaceAll(b, []byte(`${1}<redacted>`)) }

func strconvPort(v string) (int, error) { return strconv.Atoi(v) }
func writeAPIError(w http.ResponseWriter, err error) {
	if e, ok := err.(*apiError); ok {
		http.Error(w, e.reason, e.status)
		return
	}
	http.Error(w, "operation_failed", 500)
}

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

const (
	// minCpus is the smallest CPU limit a spec may ask for. Docker takes
	// NanoCpus as an integer, so a value below 1e-9 CPUs becomes 0, and 0 means
	// "no limit". 0.01 CPUs is far above that and far below any real bot.
	minCpus = 0.01
	// minGatewayPort and maxGatewayPort bound the host port a spec may ask for:
	// no privileged ports, and only ports that exist.
	minGatewayPort = 1024
	maxGatewayPort = 65535
	// maxMarkerBytes is the largest applied marker fleetd reads.
	maxMarkerBytes = 64 * 1024
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
	// Written so that a NaN fails too.
	if !(sp.Cpus >= minCpus) {
		return errForbidden("spec_invalid")
	}
	b := s.enrollment(sp.BotKey)
	if b == nil || sp.MemoryMb > b.MaxMemoryMb || sp.Cpus > b.MaxCpus || sp.PidsLimit > b.MaxPids {
		return errForbidden("limits_exceeded")
	}
	if sp.GatewayPort != 0 && (sp.GatewayPort < minGatewayPort || sp.GatewayPort > maxGatewayPort) {
		return errForbidden("spec_invalid")
	}
	// The board address of a site is a property of the site: fleetd takes it
	// from its own configuration and never from the spec.
	if sp.BoardExtraHost != "" && sp.BoardExtraHost != s.cfg.BoardExtraHost {
		return errForbidden("spec_invalid")
	}
	for _, mount := range sp.Mounts {
		if mount.ReadOnly {
			continue
		}
		if _, ok := writableMountSource(mount.Source, s.cfg.WritableMountRoots); !ok {
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

// isImageAllowed verifies that the image specifies a non-empty sha256 digest and matches
// either an exact allowed entry or an allowed pattern ending with '*' (e.g. 'repo@sha256:*').
func isImageAllowed(image string, allowedImages []string) bool {
	if len(allowedImages) == 0 {
		return false
	}
	repo, digest, ok := strings.Cut(image, "@sha256:")
	if !ok || repo == "" || digest == "" || strings.ContainsAny(image, " 	\r\n") {
		return false
	}
	for _, allowed := range allowedImages {
		prefix, _, hasWildcard := strings.Cut(allowed, "*")
		if (hasWildcard && strings.HasPrefix(image, prefix)) || (!hasWildcard && image == allowed) {
			return true
		}
	}
	return false
}

func (s *server) imageAllowed(image string) bool {
	return isImageAllowed(image, s.cfg.Images)
}

// botVolumes are the per-bot directories under volumeRoot/<botKey> that the
// compiled profile is written into and that the container sees at the same
// paths the local driver uses (template.ts BOT_VOLUME_MOUNTS).
var botVolumes = []struct{ suffix, containerPath string }{
	{"hermes", "/data/hermes"},
	{"workspace", "/workspace"},
	{"scratch", "/scratch"},
}

// pathWithin reports whether path is dir or lies below it. Both must be
// absolute; a relative one is never within.
func pathWithin(dir, path string) bool {
	if !filepath.IsAbs(dir) || !filepath.IsAbs(path) {
		return false
	}
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// writableMountSource decides whether a mount may be read-write. It may only
// when its source, with every symlink resolved, lies inside one of the
// configured writable roots (also resolved). It returns the resolved path,
// which is the one to bind, so a symlink in the source itself is not in the
// bind. Docker still resolves the path again when the container starts: the
// operator must not nest one writable source below another (see the guide). A
// source that does not exist, or whose resolved path cannot be written into a
// bind safely, is refused, and so is every source when no root is configured.
func writableMountSource(source string, roots []string) (string, bool) {
	if len(roots) == 0 || !filepath.IsAbs(source) {
		return "", false
	}
	resolved, err := filepath.EvalSymlinks(source)
	if err != nil || strings.ContainsAny(resolved, ":,") {
		return "", false
	}
	for _, root := range roots {
		realRoot, err := filepath.EvalSymlinks(root)
		if err != nil || realRoot == string(filepath.Separator) {
			continue
		}
		if pathWithin(realRoot, resolved) {
			return resolved, true
		}
	}
	return "", false
}

// binds returns the Docker bind list for a container: the bot's own volume
// directories (read-write, so the profile written by writeProfile reaches the
// container) and the extra mounts. An extra mount is read-only, unless it asks
// for read-write and its source is inside a writable root (see
// writableMountSource). It has no side effects: drift checks call it too.
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
		if mount.ReadOnly {
			binds = append(binds, mount.Source+":"+mount.Destination+":ro")
			continue
		}
		source, ok := writableMountSource(mount.Source, s.cfg.WritableMountRoots)
		if !ok {
			return nil, errForbidden("mount_not_allowed")
		}
		binds = append(binds, source+":"+mount.Destination+":rw")
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
	s.gatewayMu.Lock()
	defer s.gatewayMu.Unlock()
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
		if filepath.Clean(m.Destination) != m.Destination || strings.Contains(m.Source, "..") || strings.ContainsAny(m.Source, ":,") || strings.ContainsAny(m.Destination, ":,") {
			return fmt.Errorf("mount_invalid")
		}
		ok := false
		for _, root := range allowed {
			if m.Source == root || strings.HasPrefix(m.Source, strings.TrimSuffix(root, "/")+"/") {
				ok = true
				break
			}
		}
		for _, protected := range []string{"/data/hermes", "/workspace", "/scratch"} {
			if m.Destination == protected || strings.HasPrefix(m.Destination, protected+"/") {
				return fmt.Errorf("mount_invalid")
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
	return nil
}

// markerRelativePath is where the applied-state marker lives, relative to the
// bot's volume root; the same file name the local driver uses, inside hermes.
const markerRelativePath = "hermes/.myrmidon/applied.json"

// idleStoppedRelativePath is where the IDLE-STOP mark lives, relative to the
// bot's volume root (OPE-12663). The bot owns this directory: the mark is read
// with the same distrust as the applied marker (readMarker) and written with
// the same atomic discipline (writeProfileFile).
const idleStoppedRelativePath = "hermes/.myrmidon/idle-stopped.json"

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
	chownDirsUp(realRoot, realDir)
	return os.Rename(tmpName, target)
}

// chownDirsUp gives the bot user every directory from dir up to, but not
// including, realRoot (the root of the bot volume stays as the volume rules
// require). MkdirAll creates the missing intermediate directories as the
// fleetd user, so chowning only the file's own directory left e.g.
// hermes/skills and hermes/skills/paperclip-managed root-owned with mode 0700,
// and the bot could not read its managed skills ("Permission denied:
// /data/hermes/skills/paperclip-managed", T4 canary on myr-vm1, 08.11).
// Best effort like the file chown above: fleetd may run unprivileged.
func chownDirsUp(realRoot, dir string) {
	for d := dir; ; d = filepath.Dir(d) {
		rel, err := filepath.Rel(realRoot, d)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, "../") {
			return
		}
		_ = lchown(d, botUID, botUID)
	}
}

// readMarker reads the applied marker without trusting the path. The bot owns
// the directory the marker lives in, and fleetd runs as root, so the file may
// be anything: a symlink to /dev/zero or to a root-only file, or a FIFO that
// blocks the open and then the read. The file is opened without following a
// final symlink and without blocking, must be a regular file by fstat on the
// open descriptor (no gap between check and read), and at most maxMarkerBytes
// are read. Anything else is "no marker".
func readMarker(path string) ([]byte, bool) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		return nil, false
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxMarkerBytes+1))
	if err != nil || len(raw) > maxMarkerBytes {
		return nil, false
	}
	return raw, true
}

// fillApplied sets the applied profile hashes of a status from the marker.
// A missing container, a missing marker or an unreadable one leave them nil:
// the board then reads "nothing verified applied" and plans a restart.
func (s *server) fillApplied(st *botStatus) {
	if st.State == "missing" || s.cfg.VolumeRoot == "" || !validBotKey(st.BotKey) {
		return
	}
	raw, ok := readMarker(filepath.Join(s.cfg.VolumeRoot, st.BotKey, markerRelativePath))
	if !ok {
		return
	}
	// The marker lives on a volume the bot can write: it is data, not trusted state.
	var m appliedMarker
	if json.Unmarshal(raw, &m) != nil || m.RestartHash == "" || m.FilesHash == "" || len(m.RestartHash) > 128 || len(m.FilesHash) > 128 {
		return
	}
	st.RestartHash, st.FilesHash = &m.RestartHash, &m.FilesHash
}

// idleStoppedMark is the on-disk shape of the IDLE-STOP mark.
type idleStoppedMark struct {
	BotKey      string `json:"botKey"`
	IdleStopped bool   `json:"idleStopped"`
}

// stopIdle implements the IDLE-STOP action (OPE-12663): stop the container,
// then record the mark. If the mark cannot be written the container is started
// back up — never left down without its mark — and the error travels to the
// board, same failure mode as the local docker driver's stopIdle.
func (s *server) stopIdle(ctx context.Context, botKey string) error {
	if err := s.docker.action(ctx, botKey, "stop"); err != nil {
		return err
	}
	if err := s.writeIdleStopped(botKey, true); err != nil {
		_ = s.docker.action(ctx, botKey, "start")
		return fmt.Errorf("failed to record idle-stopped state for bot %s: %w", botKey, err)
	}
	return nil
}

// writeIdleStopped atomically writes or removes the mark under the bot's
// volume root. The path is fixed by fleetd (the bot key is validated, the
// write goes through writeProfileFile), so a mark file is always fleetd's own,
// not bot-authored data.
func (s *server) writeIdleStopped(botKey string, stopped bool) error {
	if s.cfg.VolumeRoot == "" {
		return errForbidden("volume_root_not_configured")
	}
	if !validBotKey(botKey) {
		return errForbidden("bad_bot_key")
	}
	root := filepath.Join(s.cfg.VolumeRoot, botKey)
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	if !stopped {
		target := filepath.Join(realRoot, filepath.Clean(idleStoppedRelativePath))
		if rel, e := filepath.Rel(realRoot, target); e != nil || rel == "." || strings.HasPrefix(rel, "..") {
			return errForbidden("profile_path_invalid")
		}
		if e := os.Remove(target); e != nil && !os.IsNotExist(e) {
			return e
		}
		return nil
	}
	mark, err := json.Marshal(idleStoppedMark{BotKey: botKey, IdleStopped: true})
	if err != nil {
		return err
	}
	return s.writeProfileFile(realRoot, profileFile{Path: idleStoppedRelativePath, Content: string(mark) + "\n", Mode: 0600, Secret: true})
}

// clearIdleStopped removes the mark best-effort: it is advisory state, and the
// callers (start/restart/stop/create/recreate) must not fail because a stale
// mark could not be removed.
func (s *server) clearIdleStopped(botKey string) {
	_ = s.writeIdleStopped(botKey, false)
}

// fillIdleStopped sets the idle-stopped flag of a status from the mark file
// (OPE-12663). A missing container, a missing mark or an unreadable one leaves
// it nil — the board then reads "not idle-stopped". The file lives on a volume
// the bot can write: it is read with the applied marker's distrust, and only
// a well-formed mark naming this bot counts.
func (s *server) fillIdleStopped(st *botStatus) {
	if st.State == "missing" || s.cfg.VolumeRoot == "" || !validBotKey(st.BotKey) {
		return
	}
	raw, ok := readMarker(filepath.Join(s.cfg.VolumeRoot, st.BotKey, idleStoppedRelativePath))
	if !ok {
		return
	}
	var m idleStoppedMark
	if json.Unmarshal(raw, &m) != nil || !m.IdleStopped || m.BotKey != st.BotKey {
		return
	}
	stopped := true
	st.IdleStopped = &stopped
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

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
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
	_, err := s.binds(sp)
	return err
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

func (s *server) binds(sp spec) ([]string, error) {
	root := filepath.Join(s.cfg.VolumeRoot, sp.BotKey)
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	binds := []string{root + ":/home/bot/data:ro"}
	for _, mount := range sp.Mounts {
		if !mount.ReadOnly {
			return nil, errForbidden("mount_not_allowed")
		}
		binds = append(binds, mount.Source+":"+mount.Destination+":ro")
	}
	return binds, nil
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
func (s *server) writeProfile(p profile) error {
	if !validBotKey(p.BotKey) {
		return errForbidden("bad_bot_key")
	}
	root := filepath.Join(s.cfg.VolumeRoot, p.BotKey)
	for _, f := range p.Files {
		if !safeAbs("/"+f.Path) || strings.Contains(f.Path, "..") || strings.HasPrefix(f.Path, "/") {
			return errForbidden("profile_path_invalid")
		}
		target := filepath.Join(root, filepath.Clean(f.Path))
		rel, e := filepath.Rel(root, target)
		if e != nil || strings.HasPrefix(rel, "..") {
			return errForbidden("profile_path_invalid")
		}
		mode := os.FileMode(f.Mode) & 0777
		if mode == 0 {
			mode = 0600
		}
		if f.Secret {
			mode = 0600
		}
		if e = os.MkdirAll(filepath.Dir(target), 0700); e != nil {
			return e
		}
		if e = os.WriteFile(target, []byte(f.Content), mode); e != nil {
			return e
		}
		if f.Secret {
			if e = os.Chmod(target, 0600); e != nil {
				return e
			}
		}
	}
	return nil
}

var secretPattern = regexp.MustCompile(`(?i)(["']?(?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^\s"']+`)

func redactLogs(b []byte) []byte { return secretPattern.ReplaceAll(b, []byte(`${1}<redacted>`)) }

func strconvPort(v string) (int, error) { return strconv.Atoi(v) }
func hashSecret(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:12]
}
func writeAPIError(w http.ResponseWriter, err error) {
	if e, ok := err.(*apiError); ok {
		http.Error(w, e.reason, e.status)
		return
	}
	http.Error(w, "operation_failed", 500)
}
func urlPath(key string) string { return url.PathEscape(key) }
func (s *server) dockerDelete(ctx context.Context, key string) error {
	status, _, err := s.docker.call(ctx, http.MethodDelete, dockerAPIPrefix+"/containers/"+urlPath(containerName(key))+"?force=true", nil)
	if err != nil {
		return err
	}
	if status != 204 && status != 404 {
		return dockerError(status)
	}
	return nil
}
func fileHash(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }

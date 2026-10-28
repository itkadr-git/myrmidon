package main

import (
	"context"
	"net"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// version is set at build time with -ldflags "-X main.version=..." or defaults to 1.6.6.
var version = "1.6.6"

type siteCapacity struct {
	CPUCores int64 `json:"cpuCores"`
	MemoryMb int64 `json:"memoryMb"`
	DiskGb   int64 `json:"diskGb"`
}

type siteAllocated struct {
	CPUCores        float64 `json:"cpuCores"`
	MemoryMb        int64   `json:"memoryMb"`
	Pids            int64   `json:"pids"`
	ContainersCount int     `json:"containersCount"`
}

type egressStatus struct {
	Ok            bool     `json:"ok"`
	Timestamp     string   `json:"timestamp"`
	FailedTargets []string `json:"failedTargets,omitempty"`
}

// siteHealth is GET /v1/health (RemoteSiteHealthResponse in
// server/src/myrmidon/bot-containers/remote-site-contract.ts).
type siteHealth struct {
	SiteId      string        `json:"siteId"`
	Epoch       int64         `json:"epoch"`
	Status      string        `json:"status"`
	Capacity    siteCapacity  `json:"capacity"`
	Allocated   siteAllocated `json:"allocated"`
	EgressCheck egressStatus  `json:"egressCheck"`
	Version     string        `json:"version,omitempty"`
}

// memTotalMb reads MemTotal from /proc/meminfo; 0 when it is unavailable.
func memTotalMb() int64 {
	raw, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, "MemTotal:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			if kb, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
				return kb / 1024
			}
		}
	}
	return 0
}

// diskTotalGb is the size of the file system holding the bot volumes.
func diskTotalGb(path string) int64 {
	if path == "" {
		path = "/"
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0
	}
	return int64(st.Blocks) * int64(st.Bsize) >> 30
}

// egress probes the board address (host:port) with a TCP connect. Without a
// configured boardAddress there is nothing to probe and the check passes with
// no targets.
func (s *server) egress(ctx context.Context) egressStatus {
	out := egressStatus{Ok: true, Timestamp: time.Now().UTC().Format(time.RFC3339)}
	if s.cfg.BoardAddress == "" {
		return out
	}
	d := net.Dialer{Timeout: 3 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", s.cfg.BoardAddress)
	if err != nil {
		out.Ok = false
		out.FailedTargets = []string{s.cfg.BoardAddress}
		return out
	}
	_ = conn.Close()
	return out
}

// health answers GET /v1/health with the site's real resources: host CPU,
// memory and disk of the volume root, what the enrolled bots may use, whether
// Docker answers and whether the board is reachable.
func (s *server) health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed)
		return
	}
	var alloc siteAllocated
	for i := range s.cfg.Bots {
		alloc.CPUCores += s.cfg.Bots[i].MaxCpus
		alloc.MemoryMb += s.cfg.Bots[i].MaxMemoryMb
		alloc.Pids += s.cfg.Bots[i].MaxPids
	}
	alloc.ContainersCount = len(s.cfg.Bots)
	status := "healthy"
	if s.docker == nil || s.docker.request(r.Context(), http.MethodGet, "/_ping", nil, nil) != nil {
		status = "degraded"
	}
	eg := s.egress(r.Context())
	if !eg.Ok {
		status = "degraded"
	}
	v := version
	if s.cfg.Version != "" {
		v = s.cfg.Version
	}
	writeJSON(w, siteHealth{
		SiteId: s.cfg.SiteId,
		Epoch:  s.cfg.Epoch,
		Status: status,
		Capacity: siteCapacity{
			CPUCores: int64(runtime.NumCPU()),
			MemoryMb: memTotalMb(),
			DiskGb:   diskTotalGb(s.cfg.VolumeRoot),
		},
		Allocated:   alloc,
		EgressCheck: eg,
		Version:     v,
	})
}

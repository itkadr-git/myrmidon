// cmd/fleetd/oom.go
// myrmidon(OPE-9934): transport of docker events oom and cgroup memory.events oom_kill in fleetd.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type oomEvent struct {
	ContainerID    string `json:"containerId"`
	BotKey         string `json:"botKey"`
	Name           string `json:"name"`
	Time           int64  `json:"time"`
	TimeNano       int64  `json:"timeNano"`
	Source         string `json:"source"`
	CgroupOomKills int64  `json:"cgroupOomKills,omitempty"`
}

type oomStore struct {
	mu     sync.RWMutex
	events []oomEvent
	max    int
}

func newOomStore(max int) *oomStore {
	if max <= 0 {
		max = 1000
	}
	return &oomStore{max: max}
}

func (s *oomStore) add(e oomEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, e)
	if len(s.events) > s.max {
		s.events = s.events[len(s.events)-s.max:]
	}
}

func (s *oomStore) since(sinceNano int64) []oomEvent {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if sinceNano <= 0 {
		out := make([]oomEvent, len(s.events))
		copy(out, s.events)
		return out
	}
	var out []oomEvent
	for _, e := range s.events {
		if e.TimeNano > sinceNano || (e.Time > sinceNano && sinceNano < 1e11) {
			out = append(out, e)
		}
	}
	return out
}

func (s *server) eventsOom(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed)
		return
	}
	var sinceNano int64
	if q := r.URL.Query().Get("since"); q != "" {
		if val, err := strconv.ParseInt(q, 10, 64); err == nil {
			sinceNano = val
		}
	}
	if s.oom == nil {
		writeJSON(w, map[string]any{"events": []oomEvent{}})
		return
	}
	events := s.oom.since(sinceNano)
	if events == nil {
		events = []oomEvent{}
	}
	writeJSON(w, map[string]any{"events": events})
}

func (s *server) startOomListener(ctx context.Context) {
	upstream := s.cfg.Upstream
	if upstream == "" {
		upstream = "/var/run/docker.sock"
	}
	backoff := 500 * time.Millisecond
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		err := s.consumeDockerEvents(ctx, upstream)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return
			}
			if backoff < 10*time.Second {
				backoff *= 2
			}
		} else {
			backoff = 500 * time.Millisecond
		}
	}
}

func (s *server) consumeDockerEvents(ctx context.Context, socketPath string) error {
	dialer := net.Dialer{}
	conn, err := dialer.DialContext(ctx, "unix", socketPath)
	if err != nil {
		return err
	}
	defer conn.Close()

	req, err := http.NewRequestWithContext(ctx, "GET", "/v1.45/events?filters=%7B%22type%22%3A%5B%22container%22%5D%2C%22event%22%3A%5B%22oom%22%5D%7D", nil)
	if err != nil {
		return err
	}
	req.Host = "docker"
	if err := req.Write(conn); err != nil {
		return err
	}

	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("docker events status: %d", resp.StatusCode)
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var raw struct {
			Action string `json:"Action"`
			Actor  struct {
				ID         string            `json:"ID"`
				Attributes map[string]string `json:"Attributes"`
			} `json:"Actor"`
			Time     int64 `json:"time"`
			TimeNano int64 `json:"timeNano"`
		}
		if err := json.Unmarshal(line, &raw); err != nil {
			continue
		}
		if raw.Action != "oom" {
			continue
		}
		name := raw.Actor.Attributes["name"]
		cleanName := strings.TrimPrefix(name, "/")
		if !strings.HasPrefix(cleanName, "myrmidon-bot-") {
			continue
		}
		botKey := extractBotKey(name)
		timeNano := raw.TimeNano
		if timeNano == 0 && raw.Time > 0 {
			timeNano = raw.Time * 1e9
		}

		cgroupOom := readCgroupOomKills(raw.Actor.ID)

		if s.oom != nil {
			s.oom.add(oomEvent{
				ContainerID:    raw.Actor.ID,
				BotKey:         botKey,
				Name:           name,
				Time:           raw.Time,
				TimeNano:       timeNano,
				Source:         "docker.events",
				CgroupOomKills: cgroupOom,
			})
		}
	}
	return scanner.Err()
}

func extractBotKey(name string) string {
	name = strings.TrimPrefix(name, "/")
	if strings.HasPrefix(name, "myrmidon-bot-") {
		rest := strings.TrimPrefix(name, "myrmidon-bot-")
		if idx := strings.Index(rest, "."); idx != -1 {
			return rest[:idx]
		}
		return rest
	}
	return ""
}

// readCgroupOomKills probes cgroup v2 memory.events for oom_kill count.
func readCgroupOomKills(containerID string) int64 {
	if containerID == "" {
		return 0
	}
	candidates := []string{
		filepath.Join("/sys/fs/cgroup/system.slice", fmt.Sprintf("docker-%s.scope", containerID), "memory.events"),
		filepath.Join("/sys/fs/cgroup/docker", containerID, "memory.events"),
		filepath.Join("/sys/fs/cgroup", containerID, "memory.events"),
	}
	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		lines := strings.Split(string(data), "\n")
		for _, line := range lines {
			parts := strings.Fields(line)
			if len(parts) == 2 && parts[0] == "oom_kill" {
				if count, err := strconv.ParseInt(parts[1], 10, 64); err == nil {
					return count
				}
			}
		}
	}
	return 0
}

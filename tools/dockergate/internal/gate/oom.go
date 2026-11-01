// internal/gate/oom.go
// myrmidon(OPE-9934): transport of docker events oom and cgroup memory.events oom_kill.
package gate

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type OomEvent struct {
	ContainerID    string `json:"containerId"`
	BotKey         string `json:"botKey"`
	Name           string `json:"name"`
	Time           int64  `json:"time"`
	TimeNano       int64  `json:"timeNano"`
	Source         string `json:"source"`
	CgroupOomKills int64  `json:"cgroupOomKills,omitempty"`
}

type OomStore struct {
	mu     sync.RWMutex
	events []OomEvent
	max    int
}

func NewOomStore(max int) *OomStore {
	if max <= 0 {
		max = 1000
	}
	return &OomStore{max: max}
}

func (s *OomStore) Add(event OomEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, event)
	if len(s.events) > s.max {
		s.events = s.events[len(s.events)-s.max:]
	}
}

func (s *OomStore) Since(sinceNano int64) []OomEvent {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if sinceNano <= 0 {
		out := make([]OomEvent, len(s.events))
		copy(out, s.events)
		return out
	}
	var out []OomEvent
	for _, e := range s.events {
		if e.TimeNano > sinceNano || (e.Time > sinceNano && sinceNano < 1e11) {
			out = append(out, e)
		}
	}
	return out
}

type dockerRawEvent struct {
	Type   string `json:"Type"`
	Action string `json:"Action"`
	Actor  struct {
		ID         string            `json:"ID"`
		Attributes map[string]string `json:"Attributes"`
	} `json:"Actor"`
	Time     int64 `json:"time"`
	TimeNano int64 `json:"timeNano"`
}

func (g *Gate) oomLoop(ctx context.Context) {
	st := g.st.Load()
	if st == nil || st.cfg == nil {
		return
	}
	socketPath := st.cfg.Upstream
	if u, err := url.Parse(socketPath); err == nil && u.Scheme == "unix" && u.Path != "" {
		socketPath = u.Path
	}
	if socketPath == "" {
		return
	}
	backoff := 500 * time.Millisecond
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		err := g.consumeDockerEvents(ctx, socketPath)
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

func (g *Gate) consumeDockerEvents(ctx context.Context, socketPath string) error {
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
		var raw dockerRawEvent
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
		botKey := ExtractBotKey(name)
		timeNano := raw.TimeNano
		if timeNano == 0 && raw.Time > 0 {
			timeNano = raw.Time * 1e9
		}
		g.oom.Add(OomEvent{
			ContainerID: raw.Actor.ID,
			BotKey:      botKey,
			Name:        name,
			Time:        raw.Time,
			TimeNano:    timeNano,
			Source:      "docker.events",
		})
	}
	return scanner.Err()
}

// ExtractBotKey extracts the bot identifier from container name.
// Non-bot containers return an empty string.
func ExtractBotKey(name string) string {
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

// cmd/fleetd/oom_test.go
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFleetd_OomStore_Since(t *testing.T) {
	s := newOomStore(10)
	s.add(oomEvent{
		ContainerID: "cid-1",
		BotKey:      "bot-1",
		Name:        "myrmidon-bot-bot-1",
		Time:        100,
		TimeNano:    100_000_000_000,
		Source:      "docker.events",
	})
	s.add(oomEvent{
		ContainerID: "cid-2",
		BotKey:      "bot-2",
		Name:        "myrmidon-bot-bot-2",
		Time:        200,
		TimeNano:    200_000_000_000,
		Source:      "docker.events",
	})

	all := s.since(0)
	if len(all) != 2 {
		t.Fatalf("expected 2 events, got %d", len(all))
	}

	since150 := s.since(150_000_000_000)
	if len(since150) != 1 {
		t.Fatalf("expected 1 event, got %d", len(since150))
	}
	if since150[0].ContainerID != "cid-2" {
		t.Errorf("expected cid-2, got %s", since150[0].ContainerID)
	}
}

func TestFleetd_EventsOom_Handler(t *testing.T) {
	store := newOomStore(10)
	store.add(oomEvent{
		ContainerID:    "test-container",
		BotKey:         "agent-test",
		Name:           "myrmidon-bot-agent-test",
		Time:           1730000000,
		TimeNano:       1730000000000000000,
		Source:         "docker.events",
		CgroupOomKills: 1,
	})

	srv := &server{
		cfg: &config{
			Token: "01234567890123456789012345678901",
		},
		oom: store,
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/events/oom", nil)
	w := httptest.NewRecorder()
	srv.eventsOom(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
	}

	var body struct {
		Events []oomEvent `json:"events"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(body.Events))
	}
	ev := body.Events[0]
	if ev.ContainerID != "test-container" || ev.BotKey != "agent-test" || ev.CgroupOomKills != 1 {
		t.Errorf("unexpected event: %+v", ev)
	}
}

func TestFleetd_ExtractBotKey(t *testing.T) {
	if got := extractBotKey("myrmidon-bot-agent-fleet"); got != "agent-fleet" {
		t.Errorf("expected agent-fleet, got %s", got)
	}
	if got := extractBotKey("/myrmidon-bot-uuid-f.task"); got != "uuid-f" {
		t.Errorf("expected uuid-f, got %s", got)
	}
	if got := extractBotKey("myrmidon-pg"); got != "" {
		t.Errorf("expected empty string for non-bot container, got %s", got)
	}
}

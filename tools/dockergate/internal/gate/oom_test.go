// internal/gate/oom_test.go
package gate_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/gate"
)

func TestOomStore_Since(t *testing.T) {
	store := gate.NewOomStore(10)
	store.Add(gate.OomEvent{
		ContainerID: "cid-1",
		BotKey:      "bot-1",
		Name:        "myrmidon-bot-bot-1",
		Time:        100,
		TimeNano:    100_000_000_000,
		Source:      "docker.events",
	})
	store.Add(gate.OomEvent{
		ContainerID: "cid-2",
		BotKey:      "bot-2",
		Name:        "myrmidon-bot-bot-2",
		Time:        200,
		TimeNano:    200_000_000_000,
		Source:      "docker.events",
	})

	all := store.Since(0)
	if len(all) != 2 {
		t.Fatalf("expected 2 events, got %d", len(all))
	}

	since150 := store.Since(150_000_000_000)
	if len(since150) != 1 {
		t.Fatalf("expected 1 event, got %d", len(since150))
	}
	if since150[0].ContainerID != "cid-2" {
		t.Errorf("expected cid-2, got %s", since150[0].ContainerID)
	}
}

func TestOom_A19_Endpoint(t *testing.T) {
	store := gate.NewOomStore(100)
	store.Add(gate.OomEvent{
		ContainerID: "c-test-123",
		BotKey:      "agent-alpha",
		Name:        "myrmidon-bot-agent-alpha",
		Time:        1730000000,
		TimeNano:    1730000000000000000,
		Source:      "docker.events",
	})

	r := newRig(t, withOom(store))
	res := r.send(http.MethodGet, "/myrmidon/events/oom", nil, nil)
	if res.Status != http.StatusOK {
		t.Fatalf("GET /myrmidon/events/oom status = %d; body = %s", res.Status, res.str())
	}

	var payload struct {
		Events []gate.OomEvent `json:"events"`
	}
	if err := json.Unmarshal(res.Body, &payload); err != nil {
		t.Fatalf("unmarshal events body: %v", err)
	}
	if len(payload.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(payload.Events))
	}
	ev := payload.Events[0]
	if ev.ContainerID != "c-test-123" || ev.BotKey != "agent-alpha" {
		t.Errorf("unexpected event: %+v", ev)
	}

	// Test query with since filter that excludes the event
	resSince := r.send(http.MethodGet, "/myrmidon/events/oom?since=1730000001000000000", nil, nil)
	if resSince.Status != http.StatusOK {
		t.Fatalf("GET with since status = %d; body = %s", resSince.Status, resSince.str())
	}
	var payloadSince struct {
		Events []gate.OomEvent `json:"events"`
	}
	if err := json.Unmarshal(resSince.Body, &payloadSince); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(payloadSince.Events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(payloadSince.Events))
	}
}

func TestExtractBotKey(t *testing.T) {
	if got := gate.ExtractBotKey("myrmidon-bot-agent-a"); got != "agent-a" {
		t.Errorf("expected agent-a, got %s", got)
	}
	if got := gate.ExtractBotKey("/myrmidon-bot-uuid-1.suffix"); got != "uuid-1" {
		t.Errorf("expected uuid-1, got %s", got)
	}
	if got := gate.ExtractBotKey("litellm-gateway"); got != "" {
		t.Errorf("expected empty string for non-bot container, got %s", got)
	}
}

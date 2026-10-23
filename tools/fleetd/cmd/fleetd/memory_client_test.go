package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewMemoryClientDisabled(t *testing.T) {
	if _, err := newMemoryClient(&memoryConfig{}); err == nil || !strings.Contains(err.Error(), "disabled") {
		t.Fatalf("expected disabled error, got %v", err)
	}
}

func TestNewMemoryClientRejectsFilesystemURL(t *testing.T) {
	for _, raw := range []string{"/var/run/memory.sock", "file:///tmp/memory", "ftp://example.com/memory"} {
		if _, err := newMemoryClient(&memoryConfig{Enabled: true, URL: raw, Bank: "fleetd"}); err == nil {
			t.Errorf("expected URL rejection for %q", raw)
		}
	}
}

func TestMemoryClientRecallForwardsContract(t *testing.T) {
	var gotAuth string
	var got map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/default/banks/fleetd/memories/recall" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"memories":[]}`))
	}))
	defer upstream.Close()

	client, err := newMemoryClient(&memoryConfig{Enabled: true, URL: upstream.URL, Token: "test-token", Bank: "fleetd"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.recall(context.Background(), "where is the runbook?", "low", 77); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer test-token" {
		t.Fatalf("authorization = %q", gotAuth)
	}
	if got["query"] != "where is the runbook?" || got["budget"] != "low" || got["max_tokens"] != float64(77) {
		t.Fatalf("request body = %#v", got)
	}
}

func TestMemoryClientTurnsUpstreamErrorsIntoExplicitErrors(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not ready", http.StatusBadGateway)
	}))
	defer upstream.Close()
	client, err := newMemoryClient(&memoryConfig{Enabled: true, URL: upstream.URL, Bank: "fleetd"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.recall(context.Background(), "query", "", 0); err == nil || !strings.Contains(err.Error(), "HTTP 502") {
		t.Fatalf("expected explicit upstream error, got %v", err)
	}
}

func TestMemoryClientRetainUsesAsyncBatch(t *testing.T) {
	var got map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/default/banks/fleetd/memories" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	defer upstream.Close()
	client, err := newMemoryClient(&memoryConfig{Enabled: true, URL: upstream.URL, Bank: "fleetd"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.retain(context.Background(), "remember this", "ops", "doc-1", map[string]any{"source": "test"}); err != nil {
		t.Fatal(err)
	}
	if got["async"] != true {
		t.Fatalf("async = %#v", got["async"])
	}
	items := got["items"].([]any)
	item := items[0].(map[string]any)
	if item["document_id"] != "doc-1" || item["context"] != "ops" {
		t.Fatalf("item = %#v", item)
	}
}

func TestMemoryClientExportUsesSiteAgentContract(t *testing.T) {
	var got map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/default/banks/fleetd/memories/export" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"items":[]}`))
	}))
	defer upstream.Close()
	client, err := newMemoryClient(&memoryConfig{Enabled: true, URL: upstream.URL, Bank: "fleetd"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.export(context.Background(), "bot-1"); err != nil {
		t.Fatal(err)
	}
	if got["botKey"] != "bot-1" {
		t.Fatalf("export body = %#v", got)
	}
}

func TestMemoryClientExportRejectsInvalidBotKey(t *testing.T) {
	client := &memoryClient{}
	if _, err := client.export(context.Background(), "../secret"); err == nil {
		t.Fatal("expected invalid bot key to be rejected")
	}
}

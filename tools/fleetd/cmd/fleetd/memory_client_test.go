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

func TestMemoryClientExportUsesAsyncBankTransferContract(t *testing.T) {
	var paths []string
	var gotAuth string
	var upstream *httptest.Server
	payload := []byte("PK\\x03\\x04archive")
	upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.RequestURI())
		gotAuth = r.Header.Get("Authorization")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/default/banks/bot-bank/transfer/export":
			if r.URL.Query().Get("include_data") != "true" || r.URL.Query().Get("include_bank_config") != "true" || r.URL.Query().Get("include_history") != "false" {
				t.Errorf("export flags = %v", r.URL.Query())
			}
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"operation_id":"op-123","status":"pending"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/default/banks/bot-bank/operations/op-123":
			_, _ = w.Write([]byte(`{"operation_id":"op-123","status":"completed","result_metadata":{"download_url":"` + upstream.URL + `/v1/default/files/download/archive-key"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/default/files/download/archive-key":
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write(payload)
		default:
			t.Errorf("unexpected upstream request: %s %s", r.Method, r.URL.RequestURI())
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	client, err := newMemoryClient(&memoryConfig{Enabled: true, URL: upstream.URL, Token: "test-token", Bank: "unused-config-bank", TimeoutMs: 3000})
	if err != nil {
		t.Fatal(err)
	}
	got, err := client.export(context.Background(), "bot-bank")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Fatalf("archive = %q", got)
	}
	if gotAuth != "Bearer test-token" {
		t.Fatalf("authorization = %q", gotAuth)
	}
	if len(paths) != 3 {
		t.Fatalf("request sequence = %#v", paths)
	}
}

func TestMemoryClientExportRejectsEmptyBankID(t *testing.T) {
	client := &memoryClient{}
	if _, err := client.export(context.Background(), " "); err == nil {
		t.Fatal("expected empty bank id to be rejected")
	}
}

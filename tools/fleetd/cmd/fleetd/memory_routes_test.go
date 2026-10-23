package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func memoryRouteServer(t *testing.T, upstream *httptest.Server) *server {
	t.Helper()
	cfg := testConfig()
	if upstream != nil {
		cfg.Memory = &memoryConfig{Enabled: true, URL: upstream.URL, Bank: "fleetd"}
		cfg.Bots = []bot{{BotKey: "bot-1", MaxMemoryMb: 1024, MaxCpus: 1, MaxPids: 128}}
	}
	mc, err := newMemoryClient(cfg.Memory)
	if upstream != nil && err != nil {
		t.Fatal(err)
	}
	return &server{cfg: cfg, memory: mc}
}

func routeMemory(s *server, method, path, token, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "http://fleetd.example.com"+path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	s.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/memory/") {
			if strings.HasSuffix(r.URL.Path, "/recall") {
				s.memoryRecall(w, r)
			} else if strings.HasSuffix(r.URL.Path, "/export") {
				s.memoryExport(w, r)
			} else {
				s.memoryRetain(w, r)
			}
			return
		}
		http.NotFound(w, r)
	})(rec, req)
	return rec
}

func TestMemoryRoutesDisabledAnswer503(t *testing.T) {
	s := memoryRouteServer(t, nil)
	rec := routeMemory(s, http.MethodPost, "/v1/memory/recall", s.cfg.Token, `{"query":"q"}`)
	if rec.Code != http.StatusServiceUnavailable || strings.TrimSpace(rec.Body.String()) != "centralized_memory_disabled" {
		t.Fatalf("recall disabled: got %d %q", rec.Code, rec.Body.String())
	}
	rec = routeMemory(s, http.MethodPost, "/v1/memory/retain", s.cfg.Token, `{"content":"c"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("retain disabled: got %d", rec.Code)
	}
	rec = routeMemory(s, http.MethodPost, "/v1/memory/export", s.cfg.Token, `{}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("export disabled: got %d", rec.Code)
	}
}

func TestMemoryRoutesRequireAuth(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	s := memoryRouteServer(t, upstream)
	if rec := routeMemory(s, http.MethodPost, "/v1/memory/recall", "", `{"query":"q"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: got %d", rec.Code)
	}
}

func TestMemoryRoutesForwardToUpstream(t *testing.T) {
	var gotPath, gotQuery, gotBot string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode upstream body: %v", err)
		}
		if q, ok := body["botKey"].(string); ok {
			gotBot = q
		}
		if q, ok := body["query"].(string); ok {
			gotQuery = q
		}
		_, _ = w.Write([]byte(`{"memories":[]}`))
	}))
	defer upstream.Close()
	s := memoryRouteServer(t, upstream)
	rec := routeMemory(s, http.MethodPost, "/v1/memory/recall", s.cfg.Token, `{"query":"fleet runbook"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("recall: got %d %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/v1/default/banks/fleetd/memories/recall" || gotQuery != "fleet runbook" {
		t.Fatalf("upstream saw %q / %q", gotPath, gotQuery)
	}
	rec = routeMemory(s, http.MethodPost, "/v1/memory/retain", s.cfg.Token, `{"content":"note"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("retain: got %d %s", rec.Code, rec.Body.String())
	}
	if !strings.HasPrefix(gotPath, "/v1/default/banks/fleetd/memories") {
		t.Fatalf("retain path = %q", gotPath)
	}
	rec = routeMemory(s, http.MethodPost, "/v1/memory/export", s.cfg.Token, `{"botKey":"bot-1"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("export: got %d %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/v1/default/banks/fleetd/memories/export" || gotBot != "bot-1" {
		t.Fatalf("export upstream saw %q / %q", gotPath, gotBot)
	}
	rec = routeMemory(s, http.MethodPost, "/v1/memory/export", s.cfg.Token, `{"botKey":"unknown"}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown bot export: got %d", rec.Code)
	}
}

func TestMemoryRoutesRejectBadBody(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	s := memoryRouteServer(t, upstream)
	if rec := routeMemory(s, http.MethodPost, "/v1/memory/recall", s.cfg.Token, `{"unknown":1}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown key: got %d", rec.Code)
	}
}

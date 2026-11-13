package main

import (
	"context"
	"net"
	"net/http"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// profileBodyFor builds a valid profile PUT body for key.
func profileBodyFor(key string) string {
	return `{"profile":{"botKey":"` + key + `","files":[{"path":"hermes/config.yaml","content":"model: test\n","mode":420,"secret":false}],"restartHash":"r1","filesHash":"f1"}}`
}

// TestDockerRoundTripsDoNotLeakGoroutinesOrHeap hammers recreate/profile/status
// through the real route handlers against the fake docker socket (OPE-12923).
// Before the fix every Docker API call built a throwaway http.Transport whose
// pooled keep-alive connection pinned its readLoop/writeLoop goroutines
// forever (IdleConnTimeout was zero), so heap grew without limit and fleetd on
// myr-vm1 was OOM-killed: ~45 MB/h at rest, ~220 MB/h under a bot roll.
// Acceptance bar (OPE-12923): after 1000 cycles the heap after GC is no more
// than 20 MB above the heap after the first 10 cycles, and no leaked
// transport keeps goroutines alive.
func TestDockerRoundTripsDoNotLeakGoroutinesOrHeap(t *testing.T) {
	s, _, _ := newServerWithDocker(t)
	key := s.cfg.Bots[0].BotKey
	token := s.cfg.Token
	recreate := createBody(key)
	profile := profileBodyFor(key)

	cycle := func() {
		if rec := routeRequest(s, http.MethodPost, "/v1/bots/"+key+"/recreate", token, recreate); rec.Code != http.StatusOK {
			t.Fatalf("recreate failed: %d %s", rec.Code, rec.Body.String())
		}
		if rec := routeRequest(s, http.MethodPut, "/v1/bots/"+key+"/profile", token, profile); rec.Code != http.StatusOK {
			t.Fatalf("profile failed: %d %s", rec.Code, rec.Body.String())
		}
		if rec := routeRequest(s, http.MethodGet, "/v1/bots/"+key+"/status", token, ""); rec.Code != http.StatusOK {
			t.Fatalf("status failed: %d %s", rec.Code, rec.Body.String())
		}
	}
	for range 10 {
		cycle()
	}
	runtime.GC()
	var base runtime.MemStats
	runtime.ReadMemStats(&base)
	baseGoroutines := runtime.NumGoroutine()

	for range 990 {
		cycle()
	}

	// After the fix the shared transport holds at most a couple of pooled
	// keep-alive connections (a few goroutines). Anything far above the
	// baseline means leaked per-call transports still pin connection
	// goroutines. The fake docker server keeps its own per-connection
	// goroutines alive too, so both sides of the socket are covered.
	deadline := time.Now().Add(5 * time.Second)
	for runtime.NumGoroutine() > baseGoroutines+32 {
		if time.Now().After(deadline) {
			t.Fatalf("goroutines grew from %d to %d after 1000 recreate/profile/status cycles: per-call Docker transports keep connection goroutines alive", baseGoroutines, runtime.NumGoroutine())
		}
		time.Sleep(50 * time.Millisecond)
	}

	runtime.GC()
	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	if grew := int64(after.HeapAlloc) - int64(base.HeapAlloc); grew > 20<<20 {
		t.Fatalf("heap grew %d bytes over 1000 cycles (baseline %d, final %d), limit is 20 MiB", grew, base.HeapAlloc, after.HeapAlloc)
	}
}

// TestDockerRequestTimesOutOnHungDaemon: the shared client has no Timeout, so
// request() must bound the call itself (OPE-12923 regression).
func TestDockerRequestTimesOutOnHungDaemon(t *testing.T) {
	sockPath := filepath.Join(t.TempDir(), "d.sock")
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	t.Cleanup(func() {
		close(done)
		ln.Close()
	})
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				<-done
				c.Close()
			}()
		}
	}()
	d := newDockerClient(&config{Upstream: sockPath})
	d.requestTimeout = 200 * time.Millisecond
	errc := make(chan error, 1)
	go func() {
		errc <- d.request(context.Background(), http.MethodGet, "/x", nil, nil)
	}()
	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("expected a timeout error from a hung daemon")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("request did not time out: the timeout context is not applied to the request")
	}
}

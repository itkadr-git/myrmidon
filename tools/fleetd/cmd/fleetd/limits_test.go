package main

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Everything here is placeholder data: fake bot keys, example.com hosts.

func TestDecodeBodyCapsTheRequestSize(t *testing.T) {
	var body specEnvelope
	small := `{"spec":{"botKey":"` + strings.Repeat("a", 1000) + `"}}`
	if err := decodeBody(httptest.NewRequest(http.MethodPost, "/v1/bots", strings.NewReader(small)), &body); err != nil {
		t.Fatalf("a small body was refused: %v", err)
	}
	huge := `{"spec":{"botKey":"` + strings.Repeat("a", maxJSONBody) + `"}}`
	err := decodeBody(httptest.NewRequest(http.MethodPost, "/v1/bots", strings.NewReader(huge)), &body)
	var tooBig *http.MaxBytesError
	if !errors.As(err, &tooBig) {
		t.Fatalf("an oversized body was not refused as too large: %v", err)
	}
}

func TestOversizedBodyIsRefusedBeforeDocker(t *testing.T) {
	s, _, fake := newServerWithDocker(t)
	key := s.cfg.Bots[0].BotKey
	huge := `{"spec":{"botKey":"` + strings.Repeat("a", maxJSONBody) + `"}}`
	for _, path := range []string{"/v1/bots/" + key + "/create", "/v1/bots/" + key + "/recreate", "/v1/bots/" + key + "/template-drift"} {
		rec := routeRequest(s, http.MethodPost, path, s.cfg.Token, huge)
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "body_not_allowed") {
			t.Fatalf("%s: expected 400 body_not_allowed, got %d %s", path, rec.Code, rec.Body.String())
		}
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.calls) != 0 {
		t.Fatalf("an oversized body reached Docker: %v", fake.calls)
	}
}

func TestCapReaderStopsPastTheLimit(t *testing.T) {
	got, err := io.ReadAll(&capReader{r: strings.NewReader("12345"), n: 5})
	if err != nil || string(got) != "12345" {
		t.Fatalf("exactly the limit must read cleanly: %q %v", got, err)
	}
	_, err = io.ReadAll(&capReader{r: strings.NewReader("123456"), n: 5})
	if !tooLarge(err) {
		t.Fatalf("one byte over the limit must fail as too large, got %v", err)
	}
}

// restoreWithCaps posts an archive to restore on a server with the given limits.
func restoreWithCaps(t *testing.T, root, key string, archive []byte, caps restoreCaps) *httptest.ResponseRecorder {
	t.Helper()
	target, _ := newServer(t)
	target.cfg.VolumeRoot = root
	target.restoreCap = caps
	req := httptest.NewRequest(http.MethodPost, "http://fleetd.example.com/v1/bots/"+key+"/restore", bytes.NewReader(archive))
	req.Header.Set("Authorization", "Bearer "+target.cfg.Token)
	rec := httptest.NewRecorder()
	target.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		target.route(w, r)
	})(rec, req)
	return rec
}

// requireNothingLeft fails when a refused restore left anything in the volume root.
func requireNothingLeft(t *testing.T, root string) {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("a refused restore left %d entries in the volume root", len(entries))
	}
}

// The test snapshot holds 3 entries and 15 bytes of file content.
func TestRestoreRefusesAnArchiveOverTheSizeLimit(t *testing.T) {
	_, key, archive := snapshotOf(t)
	root := t.TempDir()
	rec := restoreWithCaps(t, root, key, archive, restoreCaps{bytes: 14, entries: 100})
	if rec.Code != http.StatusRequestEntityTooLarge || strings.TrimSpace(rec.Body.String()) != "restore_too_large" {
		t.Fatalf("expected 413 restore_too_large, got %d %q", rec.Code, rec.Body.String())
	}
	requireNothingLeft(t, root)
}

func TestRestoreRefusesAnArchiveWithTooManyEntries(t *testing.T) {
	_, key, archive := snapshotOf(t)
	root := t.TempDir()
	rec := restoreWithCaps(t, root, key, archive, restoreCaps{bytes: 1 << 20, entries: 2})
	if rec.Code != http.StatusRequestEntityTooLarge || strings.TrimSpace(rec.Body.String()) != "restore_too_large" {
		t.Fatalf("expected 413 restore_too_large, got %d %q", rec.Code, rec.Body.String())
	}
	requireNothingLeft(t, root)
}

func TestRestoreAcceptsAnArchiveExactlyAtTheLimits(t *testing.T) {
	_, key, archive := snapshotOf(t)
	root := t.TempDir()
	rec := restoreWithCaps(t, root, key, archive, restoreCaps{bytes: 15, entries: 3})
	if rec.Code != http.StatusOK {
		t.Fatalf("an archive at the limits was refused: %d %s", rec.Code, rec.Body.String())
	}
	got, err := os.ReadFile(filepath.Join(root, key, "workspace", "code.txt"))
	if err != nil || string(got) != "hello workspace" {
		t.Fatalf("restored file: %q %v", got, err)
	}
}

func TestRestoreRefusesADeclaredSizeBeforeWritingAnything(t *testing.T) {
	var archive bytes.Buffer
	tw := tar.NewWriter(&archive)
	if err := tw.WriteHeader(&tar.Header{Name: "big.bin", Typeflag: tar.TypeReg, Mode: 0600, Size: 1 << 40}); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	status, err := extractSnapshot(&archive, dir)
	if status != http.StatusRequestEntityTooLarge || !tooLarge(err) {
		t.Fatalf("expected 413 restore_too_large, got %d %v", status, err)
	}
	requireNothingLeft(t, dir)
}

func TestDefaultRestoreLimits(t *testing.T) {
	caps := defaultRestoreCaps()
	if caps.bytes != 20<<30 || caps.entries != 2_000_000 {
		t.Fatalf("unexpected default restore limits: %+v", caps)
	}
	if got := (&server{}).restoreLimit(); got != caps {
		t.Fatalf("a server without an override must use the defaults, got %+v", got)
	}
}

func TestHTTPServerIsBoundedButWritesAreNot(t *testing.T) {
	srv := newHTTPServer("127.0.0.1:0", http.NotFoundHandler(), nil)
	if srv.ReadHeaderTimeout <= 0 || srv.ReadTimeout <= 0 || srv.IdleTimeout <= 0 {
		t.Fatalf("the read side is not bounded: %v %v %v", srv.ReadHeaderTimeout, srv.ReadTimeout, srv.IdleTimeout)
	}
	if srv.WriteTimeout != 0 {
		t.Fatalf("WriteTimeout would cut a long snapshot, got %v", srv.WriteTimeout)
	}
}

// deadlineWriter records the read deadlines set through http.ResponseController.
type deadlineWriter struct {
	http.ResponseWriter
	deadlines []time.Time
}

func (d *deadlineWriter) SetReadDeadline(t time.Time) error {
	d.deadlines = append(d.deadlines, t)
	return nil
}

func TestReadDeadlineIsLiftedForARequestWithoutBody(t *testing.T) {
	dw := &deadlineWriter{ResponseWriter: httptest.NewRecorder()}
	h := readDeadlines(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	h.ServeHTTP(dw, httptest.NewRequest(http.MethodGet, "http://fleetd.example.com/v1/health", nil))
	if len(dw.deadlines) != 1 || !dw.deadlines[0].IsZero() {
		t.Fatalf("expected one lifted deadline, got %v", dw.deadlines)
	}
}

func TestReadDeadlineIsLiftedWhenTheBodyEnds(t *testing.T) {
	dw := &deadlineWriter{ResponseWriter: httptest.NewRecorder()}
	var inHandler int
	h := readDeadlines(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inHandler = len(dw.deadlines)
		if _, err := io.ReadAll(r.Body); err != nil {
			t.Errorf("read body: %v", err)
		}
	}))
	h.ServeHTTP(dw, httptest.NewRequest(http.MethodPost, "http://fleetd.example.com/v1/bots", strings.NewReader("{}")))
	if inHandler != 0 {
		t.Fatalf("the deadline was touched before the body was read: %v", dw.deadlines)
	}
	if len(dw.deadlines) != 1 || !dw.deadlines[0].IsZero() {
		t.Fatalf("expected one lifted deadline after the body, got %v", dw.deadlines)
	}
}

func TestUploadDeadlineMovesWithProgress(t *testing.T) {
	dw := &deadlineWriter{ResponseWriter: httptest.NewRecorder()}
	body := &deadlineBody{ReadCloser: io.NopCloser(strings.NewReader("abc")), rc: http.NewResponseController(dw), stall: time.Minute}
	before := time.Now()
	if _, err := io.ReadAll(body); err != nil {
		t.Fatal(err)
	}
	if len(dw.deadlines) != 2 {
		t.Fatalf("expected a moved and a lifted deadline, got %v", dw.deadlines)
	}
	first := dw.deadlines[0]
	earliest := before.Add(time.Minute)
	latest := time.Now().Add(time.Minute)
	if first.Before(earliest) || first.After(latest) {
		t.Fatalf("the deadline %v is not one stall timeout ahead of the read", first)
	}
	if !dw.deadlines[1].IsZero() {
		t.Fatalf("the deadline was not lifted at the end of the upload: %v", dw.deadlines[1])
	}
}

// ReadTimeout is armed for the whole request. Without readDeadlines it also
// runs under a long handler and cancels the request context (a create that
// waits for an image pull would fail in its second Docker call).
func TestLongHandlerKeepsItsContextPastReadTimeout(t *testing.T) {
	contexts := make(chan error, 1)
	h := readDeadlines(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		time.Sleep(700 * time.Millisecond)
		contexts <- r.Context().Err()
		w.WriteHeader(http.StatusNoContent)
	}))
	ts := httptest.NewUnstartedServer(h)
	ts.Config.ReadTimeout = 250 * time.Millisecond
	ts.Config.IdleTimeout = time.Minute
	ts.Start()
	defer ts.Close()
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}

	for _, body := range []io.Reader{nil, strings.NewReader("{}")} {
		method := http.MethodGet
		if body != nil {
			method = http.MethodPost
		}
		req, err := http.NewRequest(method, ts.URL, body)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent {
			t.Fatalf("%s: status %d", method, resp.StatusCode)
		}
		if err := <-contexts; err != nil {
			t.Fatalf("%s: the request context was cancelled under a running handler: %v", method, err)
		}
	}
}

func TestMemoryClientCapsTheUpstreamResponse(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(bytes.Repeat([]byte("a"), maxMemoryResponse+1))
	}))
	defer upstream.Close()
	client, err := newMemoryClient(&memoryConfig{Enabled: true, URL: upstream.URL, Bank: "fleetd"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.recall(context.Background(), "query", "", 0); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("expected an oversized recall answer to be refused, got %v", err)
	}
	req, err := http.NewRequest(http.MethodGet, upstream.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.doMemoryRequest(req, 10); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("expected a download over its limit to be refused, got %v", err)
	}
}

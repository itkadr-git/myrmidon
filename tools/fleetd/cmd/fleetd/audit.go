package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// auditRouteMax caps the logged route, so a long hostile path cannot flood
// the log.
const auditRouteMax = 128

// auditEntry is one line of the audit log: who asked (the client certificate),
// what (route and method) and how it ended. It carries no body, header, query
// string or token.
type auditEntry struct {
	// Event marks the line among other output of the process.
	Event string `json:"event"`
	// Time is the start of the request in UTC.
	Time string `json:"time"`
	// Route is the path with the bot key replaced by {botKey}.
	Route string `json:"route"`
	// Method is the HTTP method.
	Method string `json:"method"`
	// BotKey is the bot the route names, when it is a valid bot key.
	BotKey string `json:"botKey,omitempty"`
	// Status is the response code; 0 means that no response was sent.
	Status int `json:"status"`
	// ClientCertSha256 is the SHA-256 of the DER client certificate, the same
	// form the clientCertSha256 allowlist of the configuration takes.
	ClientCertSha256 string `json:"clientCertSha256,omitempty"`
	// DurationMs is the time the handler took.
	DurationMs float64 `json:"durationMs"`
	// Aborted is set when the handler broke off the response (a snapshot that
	// failed in the middle of the stream).
	Aborted bool `json:"aborted,omitempty"`
}

// auditLog writes one JSON line per API request.
type auditLog struct {
	mu  sync.Mutex
	out io.Writer
	now func() time.Time
}

func newAuditLog(out io.Writer) *auditLog {
	return &auditLog{out: out, now: time.Now}
}

// wrap logs every request that reaches next, whatever its outcome: refused
// tokens, unknown routes and aborted streams included. The line is written
// after the handler, also when the handler panics.
func (a *auditLog) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := a.now()
		rec := &statusRecorder{ResponseWriter: w}
		finished := false
		defer func() {
			a.record(r, rec.status, start, finished)
		}()
		next.ServeHTTP(rec, r)
		finished = true
	})
}

func (a *auditLog) record(r *http.Request, status int, start time.Time, finished bool) {
	var entry auditEntry
	entry.Event = "audit"
	entry.Time = start.UTC().Format(time.RFC3339Nano)
	entry.Route, entry.BotKey = auditRoute(r.URL.Path)
	entry.Method = r.Method
	if status == 0 && finished {
		status = http.StatusOK
	}
	entry.Status = status
	if r.TLS != nil && len(r.TLS.PeerCertificates) > 0 {
		entry.ClientCertSha256 = certFingerprint(r.TLS.PeerCertificates[0].Raw)
	}
	entry.DurationMs = float64(a.now().Sub(start).Microseconds()) / 1000
	entry.Aborted = !finished
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	line = append(line, '\n')
	a.mu.Lock()
	defer a.mu.Unlock()
	_, _ = a.out.Write(line)
}

// auditRoute returns the path to log and the bot key it names. A valid bot key
// in /v1/bots/{botKey}/... is replaced by {botKey}, so lines of one route group
// together; any other path is logged as sent, cut to auditRouteMax.
func auditRoute(path string) (string, string) {
	route, botKey := path, ""
	if rest, ok := strings.CutPrefix(path, "/v1/bots/"); ok {
		key, action, hasAction := strings.Cut(rest, "/")
		if validBotKey(key) {
			botKey = key
			route = "/v1/bots/{botKey}"
			if hasAction {
				route += "/" + action
			}
		}
	}
	if len(route) > auditRouteMax {
		route = strings.ToValidUTF8(route[:auditRouteMax], "") + "..."
	}
	return route, botKey
}

// statusRecorder remembers the first final status a handler sent.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 && code >= 200 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(p []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(p)
}

// Flush keeps a streamed response flushable through the recorder.
func (s *statusRecorder) Flush() {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the connection below.
func (s *statusRecorder) Unwrap() http.ResponseWriter {
	return s.ResponseWriter
}

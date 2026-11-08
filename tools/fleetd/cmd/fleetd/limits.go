package main

import (
	"crypto/tls"
	"errors"
	"io"
	"net/http"
	"time"
)

// The fleet API answers every holder of a client certificate signed by the
// site CA, so nothing a client sends may cost unbounded memory, disk or time.

// maxJSONBody is the size cap of every JSON request body (create, recreate,
// template-drift, profile).
const maxJSONBody = 1 << 20

// maxRestoreBytes is the cap on the summed size of the regular files of one
// restored snapshot: 20 GiB, which leaves room above the largest bot datadir.
const maxRestoreBytes int64 = 20 << 30

// maxRestoreEntries is the cap on the archive entries of one restored snapshot.
const maxRestoreEntries int64 = 2_000_000

// tarEntryOverhead is what one tar entry may add to the stream on top of its
// content: the header, the padding and an extended header for a long name.
const tarEntryOverhead int64 = 8192

// Timeouts of the HTTP server. There is no WriteTimeout on purpose, see
// newHTTPServer.
const serverReadHeaderTimeout = 5 * time.Second
const serverReadTimeout = 60 * time.Second
const serverIdleTimeout = 2 * time.Minute

// restoreStallTimeout is how long a restore upload may pause between two reads.
const restoreStallTimeout = 2 * time.Minute

// restoreCaps are the size limits of one restore.
type restoreCaps struct {
	bytes   int64
	entries int64
}

func defaultRestoreCaps() restoreCaps {
	return restoreCaps{bytes: maxRestoreBytes, entries: maxRestoreEntries}
}

// streamCap bounds the tar stream of a restore: the file content plus what the
// entries add around it. It stops an archive that hides data where the entry
// accounting does not look (long-name headers, padding).
func (c restoreCaps) streamCap() int64 {
	return c.bytes + c.entries*tarEntryOverhead + maxJSONBody
}

// restoreLimit returns the limits of this server; the zero value of the
// override (the production case) means the defaults.
func (s *server) restoreLimit() restoreCaps {
	if s.restoreCap.bytes > 0 && s.restoreCap.entries > 0 {
		return s.restoreCap
	}
	return defaultRestoreCaps()
}

// errRestoreTooLarge is the answer 413 restore_too_large.
var errRestoreTooLarge = errors.New("restore_too_large")

// tooLarge reports whether err comes from a restore that went over its limits.
func tooLarge(err error) bool {
	return errors.Is(err, errRestoreTooLarge)
}

// capReader fails with errRestoreTooLarge as soon as more than n bytes were
// read from r. Exactly n bytes followed by the end of r still read cleanly.
type capReader struct {
	r io.Reader
	n int64
}

func (c *capReader) Read(p []byte) (int, error) {
	if c.n <= 0 {
		var probe [1]byte
		k, err := c.r.Read(probe[:])
		if k > 0 {
			return 0, errRestoreTooLarge
		}
		return 0, err
	}
	if int64(len(p)) > c.n {
		p = p[:c.n]
	}
	k, err := c.r.Read(p)
	c.n -= int64(k)
	return k, err
}

// deadlineBody ties the read deadline of the connection to a request body.
// When the body ends or fails, the deadline is lifted: the handler may run as
// long as its work needs, and the server's ReadTimeout does not cut the
// request context under it. With stall set, the deadline also moves stall
// ahead before a read, so a long upload lives as long as it makes progress.
type deadlineBody struct {
	io.ReadCloser
	rc    *http.ResponseController
	stall time.Duration
	last  time.Time
	done  bool
}

func (b *deadlineBody) Read(p []byte) (int, error) {
	if b.stall > 0 && !b.done && time.Since(b.last) >= b.stall/4 {
		b.last = time.Now()
		_ = b.rc.SetReadDeadline(b.last.Add(b.stall))
	}
	n, err := b.ReadCloser.Read(p)
	if err != nil && !b.done {
		b.done = true
		_ = b.rc.SetReadDeadline(time.Time{})
	}
	return n, err
}

// readDeadlines lifts the read deadline of a request once its body is in, or
// at once for a request without a body. The server arms ReadTimeout for the
// whole request; left in place it would also expire under a long handler and
// cancel the request context of a create that waits for an image pull.
func readDeadlines(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rc := http.NewResponseController(w)
		if r.Body == nil || r.Body == http.NoBody {
			_ = rc.SetReadDeadline(time.Time{})
		} else {
			r.Body = &deadlineBody{ReadCloser: r.Body, rc: rc}
		}
		next.ServeHTTP(w, r)
	})
}

// newHTTPServer returns the API server. The read side is bounded: the headers
// have to arrive within serverReadHeaderTimeout, the request within
// serverReadTimeout, and an idle connection is dropped after serverIdleTimeout
// (readDeadlines lifts the deadline once the body is in, and a restore upload
// keeps its own stall timer). WriteTimeout stays zero on purpose: it would cut
// a snapshot, which streams a whole datadir for as long as the client reads
// it, and a create that waits for an image pull. A client that has vanished is
// still dropped by the TCP keep-alive of the listener.
func newHTTPServer(addr string, handler http.Handler, tlsConf *tls.Config) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		TLSConfig:         tlsConf,
		ReadHeaderTimeout: serverReadHeaderTimeout,
		ReadTimeout:       serverReadTimeout,
		IdleTimeout:       serverIdleTimeout,
	}
}

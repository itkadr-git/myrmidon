package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Everything here is placeholder data, like in main_test.go.

// mutate replaces the first old in body by repl. It fails when old is absent,
// so a test never runs on a fixture that silently stayed as it was.
func mutate(t *testing.T, body, old, repl string) string {
	t.Helper()
	if !strings.Contains(body, old) {
		t.Fatalf("fixture lacks %q", old)
	}
	return strings.Replace(body, old, repl, 1)
}

// createdHostConfig returns the HostConfig of the create body that reached the
// fake Docker for a bot.
func createdHostConfig(t *testing.T, fake *fakeDocker, key string) map[string]any {
	t.Helper()
	fake.mu.Lock()
	defer fake.mu.Unlock()
	body, ok := fake.containers["fleet-"+key]
	if !ok {
		t.Fatalf("container not created, calls: %v", fake.calls)
	}
	host, _ := body["HostConfig"].(map[string]any)
	if host == nil {
		t.Fatalf("no HostConfig in %v", body)
	}
	return host
}

// bindsOf returns the Binds of the created container.
func bindsOf(t *testing.T, fake *fakeDocker, key string) []string {
	t.Helper()
	raw, _ := createdHostConfig(t, fake, key)["Binds"].([]any)
	binds := make([]string, 0, len(raw))
	for _, b := range raw {
		str, _ := b.(string)
		binds = append(binds, str)
	}
	return binds
}

func hasBind(binds []string, want string) bool {
	for _, b := range binds {
		if b == want {
			return true
		}
	}
	return false
}

// --- applied marker: the bot owns the directory, fleetd runs as root --------

const markerBase = `{"restartHash":"rh1","filesHash":"fh1","files":[]}`

// markerPathOf makes the .myrmidon directory of the first bot and returns the
// bot key and the path of its marker.
func markerPathOf(t *testing.T, s *server) (string, string) {
	t.Helper()
	key := s.cfg.Bots[0].BotKey
	if err := os.MkdirAll(filepath.Join(s.cfg.VolumeRoot, key, "hermes", ".myrmidon"), 0700); err != nil {
		t.Fatal(err)
	}
	return key, filepath.Join(s.cfg.VolumeRoot, key, markerRelativePath)
}

// appliedOf runs fillApplied for a running bot. A marker that blocks the read
// fails this test after a few seconds instead of hanging the whole run.
func appliedOf(t *testing.T, s *server, key string) botStatus {
	t.Helper()
	st := botStatus{BotKey: key, State: "running"}
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.fillApplied(&st)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("fillApplied blocks on the marker file")
	}
	return st
}

func TestFillAppliedReadsARegularMarker(t *testing.T) {
	s, _ := newServer(t)
	key, path := markerPathOf(t, s)
	if err := os.WriteFile(path, []byte(markerBase), 0600); err != nil {
		t.Fatal(err)
	}
	st := appliedOf(t, s, key)
	if st.RestartHash == nil || *st.RestartHash != "rh1" || st.FilesHash == nil || *st.FilesHash != "fh1" {
		t.Fatalf("hashes of a regular marker not reported: %+v", st)
	}
}

func TestFillAppliedIgnoresAMarkerThatIsNotARegularFile(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, path string)
	}{
		{"symlink to a valid marker", func(t *testing.T, path string) {
			target := filepath.Join(t.TempDir(), "elsewhere.json")
			if err := os.WriteFile(target, []byte(markerBase), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, path); err != nil {
				t.Fatal(err)
			}
		}},
		{"dangling symlink", func(t *testing.T, path string) {
			if err := os.Symlink(filepath.Join(t.TempDir(), "missing.json"), path); err != nil {
				t.Fatal(err)
			}
		}},
		{"fifo", func(t *testing.T, path string) {
			if err := syscall.Mkfifo(path, 0600); err != nil {
				t.Fatal(err)
			}
		}},
		{"directory", func(t *testing.T, path string) {
			if err := os.Mkdir(path, 0700); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, _ := newServer(t)
			key, path := markerPathOf(t, s)
			c.setup(t, path)
			if st := appliedOf(t, s, key); st.RestartHash != nil || st.FilesHash != nil {
				t.Fatalf("hashes reported from a marker that is not a regular file: %+v", st)
			}
		})
	}
}

func TestFillAppliedMarkerSizeLimit(t *testing.T) {
	sized := func(n int) []byte {
		return append([]byte(markerBase), bytes.Repeat([]byte(" "), n-len(markerBase))...)
	}
	cases := []struct {
		name string
		size int
		want bool
	}{
		{"exactly at the limit", maxMarkerBytes, true},
		{"one byte over", maxMarkerBytes + 1, false},
		{"far over", 8 * maxMarkerBytes, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, _ := newServer(t)
			key, path := markerPathOf(t, s)
			if err := os.WriteFile(path, sized(c.size), 0600); err != nil {
				t.Fatal(err)
			}
			st := appliedOf(t, s, key)
			if got := st.RestartHash != nil && st.FilesHash != nil; got != c.want {
				t.Fatalf("size %d: hashes reported = %v, want %v", c.size, got, c.want)
			}
		})
	}
	t.Run("sparse file of 256 MiB", func(t *testing.T) {
		s, _ := newServer(t)
		key, path := markerPathOf(t, s)
		f, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.WriteString(markerBase); err != nil {
			t.Fatal(err)
		}
		if err := f.Truncate(256 << 20); err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
		if st := appliedOf(t, s, key); st.RestartHash != nil || st.FilesHash != nil {
			t.Fatalf("hashes reported from a file of 256 MiB: %+v", st)
		}
	})
}

// --- container template ------------------------------------------------------

func TestCreateHostConfigMatchesTheLocalDriverTemplate(t *testing.T) {
	s, _, fake := newServerWithDocker(t)
	key := s.cfg.Bots[0].BotKey
	if rec := routeRequest(s, http.MethodPost, "/v1/bots", fakeBearer(), createBody(key)); rec.Code != http.StatusOK {
		t.Fatalf("create failed: %d %s", rec.Code, rec.Body.String())
	}
	host := createdHostConfig(t, fake, key)
	memory := float64(1024 * 1024 * 1024)
	if host["Memory"] != memory || host["MemorySwap"] != memory {
		t.Fatalf("Memory %v and MemorySwap %v must both be %v", host["Memory"], host["MemorySwap"], memory)
	}
	if tmpfs, _ := host["Tmpfs"].(map[string]any); len(tmpfs) != 1 || tmpfs["/tmp"] != "" {
		t.Fatalf("Tmpfs is %v", host["Tmpfs"])
	}
	if host["Init"] != true {
		t.Fatalf("Init is %v", host["Init"])
	}
	if restart, _ := host["RestartPolicy"].(map[string]any); len(restart) != 1 || restart["Name"] != "on-failure" {
		t.Fatalf("RestartPolicy is %v", host["RestartPolicy"])
	}
	for _, field := range []string{"Privileged", "PidMode", "IpcMode", "UsernsMode", "CapAdd", "Devices"} {
		if _, ok := host[field]; ok {
			t.Fatalf("HostConfig carries %s: %v", field, host[field])
		}
	}
}

func TestCreateTakesTheBoardAddressFromTheSiteConfig(t *testing.T) {
	s, _, fake := newServerWithDocker(t)
	s.cfg.GatewayPortStart, s.cfg.GatewayPortEnd = 18801, 18810
	key := s.cfg.Bots[0].BotKey
	// The spec names neither a port nor a board address: the port is allocated
	// and the address is the site's own.
	body := mutate(t, createBody(key), `,"gatewayPort":18801,"boardExtraHost":"`+testBoardExtraHost+`"`, "")
	if rec := routeRequest(s, http.MethodPost, "/v1/bots", fakeBearer(), body); rec.Code != http.StatusOK {
		t.Fatalf("create failed: %d %s", rec.Code, rec.Body.String())
	}
	hosts, _ := createdHostConfig(t, fake, key)["ExtraHosts"].([]any)
	if len(hosts) != 1 || hosts[0] != testBoardExtraHost {
		t.Fatalf("ExtraHosts is %v, want the site's %q", hosts, testBoardExtraHost)
	}
}

func TestCreateRefusesASpecOutsideThePolicy(t *testing.T) {
	cases := []struct{ name, old, repl string }{
		{"cpus that round to no limit", `"cpus":1,`, `"cpus":1e-10,`},
		{"cpus below the floor", `"cpus":1,`, `"cpus":0.009,`},
		{"privileged gateway port", `"gatewayPort":18801`, `"gatewayPort":80`},
		{"gateway port just below the range", `"gatewayPort":18801`, `"gatewayPort":1023`},
		{"gateway port above the range", `"gatewayPort":18801`, `"gatewayPort":65536`},
		{"negative gateway port", `"gatewayPort":18801`, `"gatewayPort":-1`},
		{"board address of another host", testBoardExtraHost, "other.example.test:192.0.2.66"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, _, fake := newServerWithDocker(t)
			key := s.cfg.Bots[0].BotKey
			body := mutate(t, createBody(key), c.old, c.repl)
			// Create and template-drift share the policy check.
			for _, path := range []string{"/v1/bots", "/v1/bots/" + key + "/template-drift"} {
				rec := routeRequest(s, http.MethodPost, path, fakeBearer(), body)
				if rec.Code != http.StatusForbidden || rec.Body.String() != "spec_invalid\n" {
					t.Fatalf("%s: got %d %q", path, rec.Code, rec.Body.String())
				}
			}
			if len(fake.containers) != 0 {
				t.Fatalf("a refused spec reached Docker: %v", fake.calls)
			}
		})
	}
}

func TestCreateAcceptsTheEdgesOfThePolicy(t *testing.T) {
	cases := []struct{ name, old, repl string }{
		{"smallest cpu limit", `"cpus":1,`, `"cpus":0.01,`},
		{"lowest gateway port", `"gatewayPort":18801`, `"gatewayPort":1024`},
		{"highest gateway port", `"gatewayPort":18801`, `"gatewayPort":65535`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, _, fake := newServerWithDocker(t)
			key := s.cfg.Bots[0].BotKey
			rec := routeRequest(s, http.MethodPost, "/v1/bots", fakeBearer(), mutate(t, createBody(key), c.old, c.repl))
			if rec.Code != http.StatusOK {
				t.Fatalf("create failed: %d %s", rec.Code, rec.Body.String())
			}
			if nano, _ := createdHostConfig(t, fake, key)["NanoCpus"].(float64); nano <= 0 {
				t.Fatalf("NanoCpus is %v, which Docker reads as no limit", nano)
			}
		})
	}
}

// --- writable mounts ---------------------------------------------------------

// mountRig is a site whose only writable root is <base>/cache. <base> is
// allowed as a mount source, so the writable-root check is what decides.
type mountRig struct {
	s     *server
	fake  *fakeDocker
	key   string
	cache string
	other string
}

func newMountRig(t *testing.T) *mountRig {
	t.Helper()
	s, _, fake := newServerWithDocker(t)
	// Not t.TempDir(): its name carries the name of the test, and a mount
	// source with ".." or "," in it is refused before the root check runs.
	// The directory may itself be behind a symlink; resolve it, so the paths
	// below equal what the policy resolves them to.
	dir, err := os.MkdirTemp("", "fleetd-mounts-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	base, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(base, "cache")
	other := filepath.Join(base, "other")
	for _, d := range []string{filepath.Join(cache, "pip"), other} {
		if err := os.MkdirAll(d, 0755); err != nil {
			t.Fatal(err)
		}
	}
	s.cfg.AllowedMounts = []string{base}
	s.cfg.WritableMountRoots = []string{cache}
	return &mountRig{s: s, fake: fake, key: s.cfg.Bots[0].BotKey, cache: cache, other: other}
}

// create asks for a container with the given extra mounts, the way the board
// sends them, and returns the status and the body of the answer.
func (r *mountRig) create(t *testing.T, mounts ...mountSpec) (int, string) {
	t.Helper()
	raw, err := json.Marshal(mounts)
	if err != nil {
		t.Fatal(err)
	}
	body := mutate(t, createBody(r.key), `"network":"net-a"`, `"network":"net-a","mounts":`+string(raw))
	rec := routeRequest(r.s, http.MethodPost, "/v1/bots", fakeBearer(), body)
	return rec.Code, rec.Body.String()
}

func TestWritableMountAllowedInsideAWritableRoot(t *testing.T) {
	t.Run("directory inside the root", func(t *testing.T) {
		r := newMountRig(t)
		if code, body := r.create(t, mountSpec{Source: filepath.Join(r.cache, "pip"), Destination: "/cache/pip"}); code != http.StatusOK {
			t.Fatalf("got %d %s", code, body)
		}
		binds := bindsOf(t, r.fake, r.key)
		if want := filepath.Join(r.cache, "pip") + ":/cache/pip:rw"; !hasBind(binds, want) {
			t.Fatalf("bind %s missing from %v", want, binds)
		}
	})
	t.Run("the root itself", func(t *testing.T) {
		r := newMountRig(t)
		if code, body := r.create(t, mountSpec{Source: r.cache, Destination: "/cache/all"}); code != http.StatusOK {
			t.Fatalf("got %d %s", code, body)
		}
	})
	t.Run("symlink that stays inside the root binds the resolved path", func(t *testing.T) {
		r := newMountRig(t)
		link := filepath.Join(r.cache, "link")
		if err := os.Symlink(filepath.Join(r.cache, "pip"), link); err != nil {
			t.Fatal(err)
		}
		if code, body := r.create(t, mountSpec{Source: link, Destination: "/cache/link"}); code != http.StatusOK {
			t.Fatalf("got %d %s", code, body)
		}
		binds := bindsOf(t, r.fake, r.key)
		if want := filepath.Join(r.cache, "pip") + ":/cache/link:rw"; !hasBind(binds, want) {
			t.Fatalf("bind %s missing from %v", want, binds)
		}
	})
	t.Run("read-only mount outside the root stays read-only", func(t *testing.T) {
		r := newMountRig(t)
		if code, body := r.create(t, mountSpec{Source: r.other, Destination: "/ref/docs", ReadOnly: true}); code != http.StatusOK {
			t.Fatalf("got %d %s", code, body)
		}
		binds := bindsOf(t, r.fake, r.key)
		if want := r.other + ":/ref/docs:ro"; !hasBind(binds, want) {
			t.Fatalf("bind %s missing from %v", want, binds)
		}
	})
}

func TestWritableMountRefusedOutsideAWritableRoot(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, r *mountRig) mountSpec
		want  string
	}{
		{"directory outside the root", func(t *testing.T, r *mountRig) mountSpec {
			return mountSpec{Source: r.other, Destination: "/cache/x"}
		}, "mount_not_allowed\n"},
		{"sibling that shares the name prefix of the root", func(t *testing.T, r *mountRig) mountSpec {
			sibling := r.cache + "-evil"
			if err := os.Mkdir(sibling, 0755); err != nil {
				t.Fatal(err)
			}
			return mountSpec{Source: sibling, Destination: "/cache/x"}
		}, "mount_not_allowed\n"},
		{"symlink inside the root that points outside", func(t *testing.T, r *mountRig) mountSpec {
			link := filepath.Join(r.cache, "escape")
			if err := os.Symlink(r.other, link); err != nil {
				t.Fatal(err)
			}
			return mountSpec{Source: link, Destination: "/cache/x"}
		}, "mount_not_allowed\n"},
		{"symlink inside the root that points at its parent", func(t *testing.T, r *mountRig) mountSpec {
			link := filepath.Join(r.cache, "up")
			if err := os.Symlink(filepath.Dir(r.cache), link); err != nil {
				t.Fatal(err)
			}
			return mountSpec{Source: link, Destination: "/cache/x"}
		}, "mount_not_allowed\n"},
		{"source that does not exist", func(t *testing.T, r *mountRig) mountSpec {
			return mountSpec{Source: filepath.Join(r.cache, "nothing"), Destination: "/cache/x"}
		}, "mount_not_allowed\n"},
		{"no writable root configured", func(t *testing.T, r *mountRig) mountSpec {
			r.s.cfg.WritableMountRoots = nil
			return mountSpec{Source: filepath.Join(r.cache, "pip"), Destination: "/cache/x"}
		}, "mount_not_allowed\n"},
		{"path that climbs out of the root", func(t *testing.T, r *mountRig) mountSpec {
			// Not filepath.Join: it would clean the ".." away.
			return mountSpec{Source: r.cache + "/../other", Destination: "/cache/x"}
		}, "mount_invalid\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newMountRig(t)
			mount := c.setup(t, r)
			code, body := r.create(t, mount)
			if code != http.StatusForbidden || body != c.want {
				t.Fatalf("got %d %q, want 403 %q", code, body, c.want)
			}
			if len(r.fake.containers) != 0 {
				t.Fatalf("a refused mount reached Docker: %v", r.fake.calls)
			}
		})
	}
}

func TestWritableMountRootsConfig(t *testing.T) {
	var cfg config
	raw := `{"listen":"127.0.0.1:0","writableMountRoots":["/srv/myrmidon-cache"],"bots":[{"botKey":"k","maxMemoryMb":1,"maxCpus":1,"maxPids":1}]}`
	if err := strictDecode([]byte(raw), &cfg); err != nil || len(cfg.WritableMountRoots) != 1 || cfg.WritableMountRoots[0] != "/srv/myrmidon-cache" {
		t.Fatalf("writableMountRoots not read: %v %v", err, cfg.WritableMountRoots)
	}
	site := testConfig()
	site.VolumeRoot = "/srv/myrmidon-bots"
	for _, roots := range [][]string{nil, {"/srv/myrmidon-cache"}, {"/srv/myrmidon-cache", "/var/cache/bots"}} {
		site.WritableMountRoots = roots
		if err := validate(site); err != nil {
			t.Fatalf("roots %v rejected: %v", roots, err)
		}
	}
	for _, roots := range [][]string{
		{""},
		{"relative/cache"},
		{"/"},
		{"/srv/myrmidon-cache/"},
		{"/srv/a/../myrmidon-cache"},
		{"/srv/myrmidon-cache:ro"},
		{"/srv/a,b"},
		{"/srv/myrmidon-bots"},
		{"/srv/myrmidon-bots/cache"},
		{"/srv"},
	} {
		site.WritableMountRoots = roots
		if err := validate(site); err == nil {
			t.Fatalf("roots %v accepted", roots)
		}
	}
}

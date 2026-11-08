package gate_test

import (
	"bytes"
	"io/fs"
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fakedocker"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fixture"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/policy"
)

// A member of a shared isolation-scope instance (BOT-DISK-F). The bodies are the
// ones the board's own driver writes (contract/testdata/scope); the bot is only
// allowed the instance directory it is enrolled for.

func enrolled(m *fixture.Manifest, instances ...string) rigOpt {
	return withConfig(func(c *config.Config) {
		c.Bots = []config.Bot{{BotKey: m.BotKey, MaxMemoryMB: 2048, MaxCPUs: 4, MaxPids: 2048, ScopeInstances: instances}}
	})
}

func scopeFixture(t *testing.T) (*fixture.Manifest, *fixture.ScopeFixture) {
	t.Helper()
	m := fixture.Load(t)
	if m.Scope == nil {
		t.Fatal("manifest has no scope section")
	}
	return m, m.Scope
}

func TestScope_MemberBodiesAreAcceptedWhenEnrolled(t *testing.T) {
	m, sc := scopeFixture(t)
	for _, tc := range []struct{ name, file, create string }{
		{"bot", sc.Bot, "myrmidon-bot-" + m.BotKey},
		{"bot.next", sc.BotNext, "myrmidon-bot-" + m.BotKey + ".next"},
		{"helper-prepare", sc.HelperPrepare, "myrmidon-bot-" + m.BotKey + ".helper"},
		{"helper-apply", sc.HelperApply, "myrmidon-bot-" + m.BotKey + ".helper"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t, enrolled(m, sc.Instance))
			if tc.name == "bot.next" || tc.name == "helper-apply" {
				r.seedMain("running")
			}
			body := fixture.Read(t, tc.file)
			res := r.send("POST", "/v1.45/containers/create?name="+tc.create, jsonHdr, body)
			wantStatus(t, res, 201)
			c, ok := r.d.Get(tc.create)
			if !ok || !bytes.Equal(c.Create, body) {
				t.Fatalf("the daemon did not get the recorded body")
			}
		})
	}
}

func TestScope_NotEnrolledIsDenied(t *testing.T) {
	m, sc := scopeFixture(t)
	body := fixture.Read(t, sc.Bot)
	name := "myrmidon-bot-" + m.BotKey

	t.Run("no enrollment at all", func(t *testing.T) {
		r := newRig(t)
		wantDeny(t, r.send("POST", "/v1.45/containers/create?name="+name, jsonHdr, body), deny.MountSourceNotAllowed)
		r.wantNoCalls()
	})
	t.Run("enrolled for another instance", func(t *testing.T) {
		r := newRig(t, enrolled(m, "caste-00000000-0000-4000-8000-0000000000c0-marketing"))
		wantDeny(t, r.send("POST", "/v1.45/containers/create?name="+name, jsonHdr, body), deny.MountSourceNotAllowed)
		if r.created() != 0 {
			t.Fatal("created")
		}
	})
	t.Run("a sibling directory is not the instance", func(t *testing.T) {
		r := newRig(t, enrolled(m, sc.Instance))
		other := strings.Replace(string(body), sc.Root+"/"+sc.Instance+":/bot-scope", sc.Root+"/caste-other:/bot-scope", 1)
		wantDeny(t, r.send("POST", "/v1.45/containers/create?name="+name, jsonHdr, []byte(other)), deny.MountSourceNotAllowed)
	})
	t.Run("the scope root itself (broader) is not accepted", func(t *testing.T) {
		r := newRig(t, enrolled(m, sc.Instance))
		broad := strings.Replace(string(body), sc.Root+"/"+sc.Instance+":/bot-scope", sc.Root+":/bot-scope", 1)
		res := r.send("POST", "/v1.45/containers/create?name="+name, jsonHdr, []byte(broad))
		if denyCode(res) == "" {
			t.Fatalf("accepted a bind of the whole scope root")
		}
		r.wantNoCalls()
	})
	t.Run("a path-traversal instance name", func(t *testing.T) {
		r := newRig(t, enrolled(m, sc.Instance))
		evil := strings.Replace(string(body), sc.Instance+":/bot-scope", sc.Instance+"/../../etc:/bot-scope", 1)
		if denyCode(r.send("POST", "/v1.45/containers/create?name="+name, jsonHdr, []byte(evil))) == "" {
			t.Fatal("accepted")
		}
	})
}

func TestScope_BodyShapeIsFixed(t *testing.T) {
	m, sc := scopeFixture(t)
	name := "myrmidon-bot-" + m.BotKey
	body := string(fixture.Read(t, sc.Bot))
	for _, tc := range []struct{ what, old, repl string }{
		{"another Env value", `"MYRMIDON_BOT_SCOPE_SUBDIR=` + m.BotKey + `"`, `"MYRMIDON_BOT_SCOPE_SUBDIR=other"`},
		{"another tmpfs option string", "uid=10001,gid=10001,mode=0755,size=1m", "uid=0,gid=0,mode=0777"},
		{"a writable bind of the instance", ":/bot-scope\"", ":/bot-scope:ro\""},
	} {
		t.Run(tc.what, func(t *testing.T) {
			r := newRig(t, enrolled(m, sc.Instance))
			mutated := strings.Replace(body, tc.old, tc.repl, 1)
			if mutated == body {
				t.Fatalf("mutation target %q is not in the body", tc.old)
			}
			if denyCode(r.send("POST", "/v1.45/containers/create?name="+name, jsonHdr, []byte(mutated))) == "" {
				t.Fatal("accepted")
			}
			r.wantNoCalls()
		})
	}
}

func TestScope_HelperScriptMustMatchTheLayout(t *testing.T) {
	m, sc := scopeFixture(t)
	name := "myrmidon-bot-" + m.BotKey + ".helper"
	body := string(fixture.Read(t, sc.HelperPrepare))
	t.Run("isolated script with shared binds", func(t *testing.T) {
		r := newRig(t, enrolled(m, sc.Instance))
		mutated := strings.Replace(body, "data/hermes workspace scratch scope", "data/hermes workspace scratch", 1)
		wantDeny(t, r.send("POST", "/v1.45/containers/create?name="+name, jsonHdr, []byte(mutated)), deny.ScriptMismatch)
	})
	t.Run("shared script with isolated binds", func(t *testing.T) {
		r := newRig(t, enrolled(m, sc.Instance))
		iso := fixture.Read(t, "bodies/helper-prepare.json")
		mutated := strings.Replace(string(iso), "data/hermes workspace scratch", "data/hermes workspace scratch scope", 1)
		res := r.send("POST", "/v1.45/containers/create?name="+name, jsonHdr, []byte(mutated))
		if denyCode(res) == "" {
			t.Fatal("accepted")
		}
	})
	t.Run("a helper bind outside the member's own subdirectory", func(t *testing.T) {
		r := newRig(t, enrolled(m, sc.Instance))
		mutated := strings.Replace(body, "/"+m.BotKey+"/scratch:/scratch", "/other-bot/scratch:/scratch", 1)
		if denyCode(r.send("POST", "/v1.45/containers/create?name="+name, jsonHdr, []byte(mutated))) == "" {
			t.Fatal("accepted")
		}
	})
}

func TestScope_InstanceDirectoryInvariants(t *testing.T) {
	m, sc := scopeFixture(t)
	name := "myrmidon-bot-" + m.BotKey
	body := fixture.Read(t, sc.Bot)
	for _, tc := range []struct {
		what string
		path string
		fi   policy.FileInfo
		err  error
	}{
		{"the instance directory is a link", sc.Root + "/" + sc.Instance, policy.FileInfo{Dir: true, Symlink: true, UID: 0, Perm: 0o755}, nil},
		{"the instance directory is world writable", sc.Root + "/" + sc.Instance, policy.FileInfo{Dir: true, UID: 10001, Perm: 0o777}, nil},
		{"the instance directory belongs to somebody else", sc.Root + "/" + sc.Instance, policy.FileInfo{Dir: true, UID: 4242, Perm: 0o700}, nil},
		{"the scope root is not owned by root", sc.Root, policy.FileInfo{Dir: true, UID: 4242, Perm: 0o755}, nil},
		{"the member's workspace is a link", sc.Root + "/" + sc.Instance + "/" + m.BotKey + "/workspace", policy.FileInfo{Dir: true, Symlink: true, UID: 10001, Perm: 0o700}, nil},
	} {
		t.Run(tc.what, func(t *testing.T) {
			r := newRig(t, enrolled(m, sc.Instance))
			r.setFS(sc.Root, policy.FileInfo{Dir: true, UID: 0, Perm: 0o755}, nil)
			r.setFS(sc.Root+"/"+sc.Instance, policy.FileInfo{Dir: true, UID: 10001, Perm: 0o700}, nil)
			r.setFS(sc.Root+"/"+sc.Instance+"/"+m.BotKey, policy.FileInfo{Dir: true, UID: 0, Perm: 0o755}, nil)
			r.setFS(tc.path, tc.fi, tc.err)
			wantDeny(t, r.send("POST", "/v1.45/containers/create?name="+name, jsonHdr, body), deny.VolumeRootInvariant)
			if r.created() != 0 {
				t.Fatal("a container was created")
			}
		})
	}
	t.Run("a healthy tree passes", func(t *testing.T) {
		r := newRig(t, enrolled(m, sc.Instance))
		r.setFS(sc.Root, policy.FileInfo{Dir: true, UID: 0, Perm: 0o755}, nil)
		r.setFS(sc.Root+"/"+sc.Instance, policy.FileInfo{Dir: true, UID: 10001, Perm: 0o700}, nil)
		r.setFS(sc.Root+"/"+sc.Instance+"/"+m.BotKey, policy.FileInfo{Dir: true, UID: 0, Perm: 0o755}, nil)
		r.setFS(sc.Root+"/"+sc.Instance+"/"+m.BotKey+"/hermes", policy.FileInfo{Dir: true, UID: 10001, Perm: 0o700}, nil)
		wantStatus(t, r.send("POST", "/v1.45/containers/create?name="+name, jsonHdr, body), 201)
	})
	t.Run("an unreadable instance directory is a denial", func(t *testing.T) {
		r := newRig(t, enrolled(m, sc.Instance))
		r.setFS(sc.Root, policy.FileInfo{Dir: true, UID: 0, Perm: 0o755}, nil)
		r.setFS(sc.Root+"/"+sc.Instance, policy.FileInfo{}, &fs.PathError{Op: "lstat", Path: sc.Root, Err: fs.ErrPermission})
		wantDeny(t, r.send("POST", "/v1.45/containers/create?name="+name, jsonHdr, body), deny.VolumeRootInvariant)
	})
}

func TestScope_MarkerOfAMemberIsReadAtItsOwnPath(t *testing.T) {
	m, sc := scopeFixture(t)
	r := newRig(t, enrolled(m, sc.Instance))
	r.seedMain("running")
	marker := []byte("marker-tar-bytes")
	r.d.Modify(r.name(""), func(c *fakedocker.Container) { c.Marker = marker })
	target := r.target("", "/archive?path=%2Fbot-scope%2F"+m.BotKey+"%2Fhermes%2F.myrmidon%2Fapplied.json")
	res := r.send("GET", target, nil, nil)
	wantStatus(t, res, 200)
	if !bytes.Equal(res.Body, marker) {
		t.Errorf("body %q", res.Body)
	}
	// another bot's directory in the same instance is not readable through this route
	other := r.target("", "/archive?path=%2Fbot-scope%2Fsomebody-else%2Fhermes%2F.myrmidon%2Fapplied.json")
	wantDeny(t, r.send("GET", other, nil, nil), deny.RouteNotAllowed)
}

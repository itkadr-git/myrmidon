package route

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
)

// allowedEntry is one row of the allowed-routes table that the board's driver
// contract test reads (server/src/myrmidon/bot-containers/dockergate-contract.myrmidon.test.ts).
// The Template is relative to the API prefix; {name} stands for the container
// name of one of the Suffixes, {mainName} for the main name of the same bot,
// {image} for an allowed image reference and {mount} for one of Mounts.
type allowedEntry struct {
	ID       string   `json:"id"`
	Method   string   `json:"method"`
	Template string   `json:"template"`
	Suffixes []string `json:"suffixes,omitempty"`
	Mounts   []string `json:"mounts,omitempty"`
	// NoPrefix marks a route that is not under the API prefix (A14): its
	// Template is the whole request-target without the leading slash.
	NoPrefix bool `json:"noPrefix,omitempty"`
}

var allowedTable = []allowedEntry{
	{ID: A1, Method: "GET", Template: "images/{image}/json"},
	{ID: A2, Method: "GET", Template: "containers/{name}/json", Suffixes: []string{""}},
	{ID: A3, Method: "GET", Template: "containers/{name}/archive?" + markerQuery, Suffixes: []string{""}},
	// The LEGACY-layout marker and report (contract "1" images): the board reads
	// them through the /data/hermes bind instead of /bot (route.Legacy*).
	{ID: A3, Method: "GET", Template: "containers/{name}/archive?" + LegacyMarkerQuery, Suffixes: []string{""}},
	{ID: A4, Method: "POST", Template: "containers/create?name={name}", Suffixes: []string{"", ".next", ".helper"}},
	{ID: A5, Method: "PUT", Template: "containers/{name}/archive?path={mount}&noOverwriteDirNonDir=true", Suffixes: []string{".helper"}, Mounts: []string{"%2Fdata%2Fhermes", "%2Fworkspace", "%2Fscratch"}},
	{ID: A6, Method: "POST", Template: "containers/{name}/start", Suffixes: []string{"", ".helper"}},
	{ID: A7, Method: "POST", Template: "containers/{name}/wait?condition=not-running", Suffixes: []string{".helper"}},
	{ID: A8, Method: "GET", Template: "containers/{name}/logs?stdout=true&stderr=true&tail=20", Suffixes: []string{".helper"}},
	{ID: A9, Method: "DELETE", Template: "containers/{name}?force=true&v=true", Suffixes: []string{"", ".next", ".helper"}},
	{ID: A10, Method: "POST", Template: "containers/{name}/stop?t=30", Suffixes: []string{""}},
	{ID: A11, Method: "POST", Template: "containers/{name}/restart?t=30", Suffixes: []string{""}},
	{ID: A12, Method: "POST", Template: "containers/{name}/rename?name={mainName}", Suffixes: []string{".next"}},
	{ID: A13, Method: "GET", Template: "containers/{name}/archive?" + cloneReportQuery, Suffixes: []string{""}},
	{ID: A13, Method: "GET", Template: "containers/{name}/archive?" + LegacyCloneReportQuery, Suffixes: []string{""}},
	// A16: the bot skills read of BOT-SKILL-BACKIMPORT (1.6.5, OPE-6401): the
	// driver reads hermes/skills of the main container in all three root shapes.
	{ID: A16, Method: "GET", Template: "containers/{name}/archive?" + skillsReadQuery, Suffixes: []string{""}},
	{ID: A16, Method: "GET", Template: "containers/{name}/archive?" + LegacySkillsReadQuery, Suffixes: []string{""}},
	// A14: the partition and the project quotas; not a Docker call, so no API prefix.
	{ID: A14, Method: "GET", Template: strings.TrimPrefix(DiskTarget, "/"), NoPrefix: true},
}

const fixtureRelPath = "../../contract/allowed-routes.json"

func instantiate(e allowedEntry, suffix, mount string, images Images) string {
	t := e.Template
	t = strings.ReplaceAll(t, "{name}", NameOf(keyA, Suffix(suffix)))
	t = strings.ReplaceAll(t, "{mainName}", NameOf(keyA, SuffixMain))
	t = strings.ReplaceAll(t, "{mount}", mount)
	if strings.Contains(t, "{image}") {
		for p := range images {
			t = p
		}
	}
	if e.NoPrefix {
		return "/" + t
	}
	return APIPrefix + t
}

// The table is exactly what Parse allows: every row instantiated is accepted
// with its ID, the suffixes outside the row are refused, and every route ID is
// in the table.
func TestAllowedTableMatchesParse(t *testing.T) {
	images := NewImages([]string{ref1})
	seen := map[string]bool{}
	for _, e := range allowedTable {
		seen[e.ID] = true
		mounts := e.Mounts
		if len(mounts) == 0 {
			mounts = []string{""}
		}
		allowed := map[string]bool{}
		for _, sfx := range e.Suffixes {
			allowed[sfx] = true
		}
		if e.ID == A1 {
			allowed[""] = true
		}
		if e.NoPrefix {
			// No bot in the target: one instance, no suffix to vary.
			target := instantiate(e, "", "", images)
			r, derr := Parse(e.Method, target, images)
			if derr != nil || r.ID != e.ID {
				t.Errorf("%s %s: %+v %v", e.ID, target, r, derr)
			}
			for _, m := range []string{"GET", "POST", "PUT", "DELETE"} {
				if m == e.Method {
					continue
				}
				if r, derr := Parse(m, target, images); derr == nil {
					t.Errorf("%s %s: allowed as %+v, the table lists only %s", m, target, r, e.Method)
				}
			}
			continue
		}
		for _, mount := range mounts {
			if e.ID == A1 {
				r, derr := Parse(e.Method, instantiate(e, "", mount, images), images)
				if derr != nil || r.ID != e.ID {
					t.Errorf("%s: %+v %v", e.ID, r, derr)
				}
				continue
			}
			for _, sfx := range []string{"", ".next", ".helper"} {
				target := instantiate(e, sfx, mount, images)
				r, derr := Parse(e.Method, target, images)
				if allowed[sfx] {
					if derr != nil || r.ID != e.ID {
						t.Errorf("%s %s: want allowed, got %+v %v", e.Method, target, r, derr)
					}
				} else if derr == nil && r.ID == e.ID {
					t.Errorf("%s %s: allowed, but the table lists suffixes %v", e.Method, target, e.Suffixes)
				}
			}
		}
	}
	for _, id := range []string{A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A16} {
		if !seen[id] {
			t.Errorf("route %s is not in the allowed table", id)
		}
	}
	// A call the table does not contain stays refused.
	if _, derr := Parse("GET", APIPrefix+"containers/json?all=true", images); derr == nil || derr.Code != deny.RouteNotAllowed {
		t.Errorf("containers/json must stay on the closed list: %v", derr)
	}
}

// The fixture the TypeScript contract test reads is the table above. It is
// generated here (Go is the source of truth), so it lives beside testdata, not in
// it: CI diffs testdata against what emit-fixtures.ts (the TS side) writes. After a
// route change run: UPDATE_ALLOWED_ROUTES=1 go test ./internal/route
func TestAllowedRoutesFixtureIsCurrent(t *testing.T) {
	want, err := json.MarshalIndent(map[string]any{
		"apiPrefix": "/" + strings.Trim(APIPrefix, "/"),
		"routes":    allowedTable,
	}, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, '\n')
	path := filepath.FromSlash(fixtureRelPath)
	if os.Getenv("UPDATE_ALLOWED_ROUTES") == "1" {
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("%s is stale: run UPDATE_ALLOWED_ROUTES=1 go test ./internal/route", fixtureRelPath)
	}
}

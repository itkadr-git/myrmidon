package gate_test

import (
	"strings"
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/fakedocker"
)

// OPE-12922: inspectOnlyImages opens the A1 inspect of host images for the
// board's stack registry and nothing else.

const (
	inspectOnlyRef = "clickhouse/clickhouse-server:25.12"
	inspectOnlyID  = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
)

func withInspectOnly(refs ...string) rigOpt {
	return withConfig(func(c *config.Config) { c.InspectOnlyImages = refs })
}

func inspectOnlyTarget(ref string) string { return "/v1.45/images/" + imageSeg(ref) + "/json" }

func TestInspectOnly_A1_Allowed_LabelsOnly(t *testing.T) {
	r := newRig(t, withInspectOnly(inspectOnlyRef))
	r.d.AddImage(fakedocker.Image{
		Ref: inspectOnlyRef, ID: inspectOnlyID,
		Labels: map[string]string{"org.opencontainers.image.version": "25.12"},
		Env:    []string{"PATH=/usr/bin", "CANARY_SECRET=hunter2"},
	})
	res := r.send("GET", inspectOnlyTarget(inspectOnlyRef), nil, nil)
	wantStatus(t, res, 200)
	if !strings.Contains(res.str(), inspectOnlyID) || !strings.Contains(res.str(), "25.12") {
		t.Errorf("body %q", res.str())
	}
	if strings.Contains(res.str(), "hunter2") || strings.Contains(res.str(), "Env") {
		t.Errorf("the image environment leaked: %q", res.str())
	}
}

func TestInspectOnly_A1_RefInNeitherListIsDenied(t *testing.T) {
	r := newRig(t, withInspectOnly(inspectOnlyRef))
	res := r.send("GET", inspectOnlyTarget("clickhouse/clickhouse-server:24.1"), nil, nil)
	wantDeny(t, res, deny.RouteNotAllowed)
	res = r.send("GET", inspectOnlyTarget("busybox:latest"), nil, nil)
	wantDeny(t, res, deny.RouteNotAllowed)
	r.wantNoCalls()
}

func TestInspectOnly_A1_OtherMethodsDenied(t *testing.T) {
	r := newRig(t, withInspectOnly(inspectOnlyRef))
	for _, m := range []string{"POST", "PUT", "DELETE"} {
		wantDeny(t, r.send(m, inspectOnlyTarget(inspectOnlyRef), nil, nil), deny.RouteNotAllowed)
	}
	r.wantNoCalls()
}

func TestInspectOnly_CreateWithInspectOnlyRefIsDenied(t *testing.T) {
	r := newRig(t, withInspectOnly(inspectOnlyRef))
	b, body := r.m.FindBody(t, "bot-plain", "")
	mut := strings.Replace(string(body), `"Image":"`+r.m.Image+`"`, `"Image":"`+inspectOnlyRef+`"`, 1)
	if mut == string(body) {
		t.Fatal("the recorded body has no image to replace")
	}
	res := r.send("POST", "/v1.45/containers/create?name="+b.Name, jsonHdr, []byte(mut))
	wantDeny(t, res, deny.ImageNotAllowed)
	if r.created() != 0 {
		t.Errorf("creates: %d", r.created())
	}
}

package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestReconcilerSpecContract(t *testing.T) {
	fixture, err := os.ReadFile("testdata/reconciler-spec.json")
	if err != nil {
		t.Fatalf("failed to read testdata/reconciler-spec.json: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/bots", bytes.NewReader(fixture))
	var body struct {
		Spec spec `json:"spec"`
	}
	if err := decodeBody(req, &body); err != nil {
		t.Fatalf("decodeBody rejected reconciler wire spec: %v", err)
	}
	if body.Spec.BotKey == "" || body.Spec.Image == "" {
		t.Fatalf("incomplete spec decoded: %+v", body.Spec)
	}
	if len(body.Spec.Mounts) == 0 {
		t.Fatalf("expected mounts in decoded spec: %+v", body.Spec)
	}
	if body.Spec.Mounts[0].Destination != "/opt/shared" {
		t.Fatalf("expected mount destination /opt/shared, got %q", body.Spec.Mounts[0].Destination)
	}
}

func TestReconcilerProfileContract(t *testing.T) {
	fixture, err := os.ReadFile("testdata/reconciler-profile.json")
	if err != nil {
		t.Fatalf("failed to read testdata/reconciler-profile.json: %v", err)
	}

	req := httptest.NewRequest(http.MethodPut, "/v1/bots/dummy/profile", bytes.NewReader(fixture))
	var body struct {
		Profile profile `json:"profile"`
	}
	if err := decodeBody(req, &body); err != nil {
		t.Fatalf("decodeBody rejected reconciler wire profile: %v", err)
	}
	if body.Profile.BotKey == "" || len(body.Profile.Files) == 0 {
		t.Fatalf("incomplete profile decoded: %+v", body.Profile)
	}
}

func TestInternalReconcilerSpecRejectedByFleetdDisallowUnknownFields(t *testing.T) {
	// Proves that fleetd's DisallowUnknownFields strictly rejects internal reconciler specs
	// that carry extraMounts or sharedMount, demonstrating the exact P0 defect (OPE-11723).
	rawInternalSpec := []byte(`{
		"spec": {
			"botKey": "2b5b878c-0000-0000-0000-000000000000",
			"image": "ghcr.io/itkadr-git/myrmidon-bot@sha256:0123456789abcdef",
			"memoryMb": 4096,
			"cpus": 2,
			"pidsLimit": 512,
			"network": "myrmidon-bot-net",
			"extraMounts": [{"source": "/srv/myrmidon-shared", "containerPath": "/opt/shared", "readOnly": true}],
			"sharedMount": {"hostPath": "/srv/shared", "writable": true}
		}
	}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/bots", bytes.NewReader(rawInternalSpec))
	var body struct {
		Spec spec `json:"spec"`
	}
	if err := decodeBody(req, &body); err == nil {
		t.Fatalf("expected decodeBody to reject raw internal spec with unknown fields, but it succeeded")
	}
}

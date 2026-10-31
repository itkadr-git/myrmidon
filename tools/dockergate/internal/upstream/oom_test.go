package upstream

import (
	"encoding/json"
	"testing"
)

func TestTrimmedPreservesOomEvidenceWithoutExposingRuntimeSecrets(t *testing.T) {
	var c Container
	if err := json.Unmarshal([]byte(`{"Id":"container-a","State":{"OOMKilled":true,"FinishedAt":"2026-10-27T12:00:00Z","Pid":123},"Config":{"Env":["SECRET=hidden"]}}`), &c); err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(c.Trimmed(), &result); err != nil {
		t.Fatal(err)
	}
	state := result["State"].(map[string]any)
	if state["OOMKilled"] != true || state["FinishedAt"] != "2026-10-27T12:00:00Z" {
		t.Fatalf("lost OOM evidence: %v", state)
	}
	if _, ok := state["Pid"]; ok {
		t.Fatal("leaked pid")
	}
	if _, ok := result["Config"].(map[string]any)["Env"]; ok {
		t.Fatal("leaked env")
	}
}

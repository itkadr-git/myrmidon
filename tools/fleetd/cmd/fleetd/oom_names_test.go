package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"path/filepath"
	"testing"
)

// Everything here is placeholder data: fake bot keys.

func TestFleetd_ExtractBotKeyKnowsBothContainerPrefixes(t *testing.T) {
	cases := []struct{ name, want string }{
		{"fleet-bot-example-one", "bot-example-one"},
		{"/fleet-bot-example-one", "bot-example-one"},
		{"fleet-bot-example-one.1", "bot-example-one"},
		{"myrmidon-bot-agent-test", "agent-test"},
		{"/myrmidon-bot-agent-test.task", "agent-test"},
		{"myrmidon-pg", ""},
		{"wg-fleet", ""},
		{"fleet", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := extractBotKey(c.name); got != c.want {
			t.Errorf("extractBotKey(%q) = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestFleetd_BotContainerPrefix(t *testing.T) {
	for _, name := range []string{"fleet-bot-example-one", "myrmidon-bot-agent-test"} {
		if !hasBotContainerPrefix(name) {
			t.Errorf("hasBotContainerPrefix(%q) = false, want true", name)
		}
	}
	for _, name := range []string{"myrmidon-pg", "wg-fleet", "fleet"} {
		if hasBotContainerPrefix(name) {
			t.Errorf("hasBotContainerPrefix(%q) = true, want false", name)
		}
	}
}

// fleetd names its containers "fleet-<botKey>" (dockerClient.name), so the oom
// listener has to keep those events as well as the "myrmidon-bot-" ones.
func TestFleetd_OomPrefixes(t *testing.T) {
	names := []string{"/fleet-bot-example-one", "myrmidon-bot-agent-test", "fleet-bot-example-two.1", "myrmidon-pg", "wg-fleet", "fleet"}
	socket := filepath.Join(t.TempDir(), "docker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	dockerHTTP := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		for i, name := range names {
			line := fmt.Sprintf(`{"Action":"oom","Actor":{"ID":"c%d","Attributes":{"name":%q}},"time":1730000000,"timeNano":1730000000000000000}`, i, name)
			_, _ = w.Write([]byte(line + "\n"))
		}
	})}
	t.Cleanup(func() {
		_ = dockerHTTP.Close()
		_ = listener.Close()
	})
	go func() { _ = dockerHTTP.Serve(listener) }()

	srv := &server{cfg: &config{}, oom: newOomStore(10)}
	if err := srv.consumeDockerEvents(context.Background(), socket); err != nil {
		t.Fatalf("consumeDockerEvents: %v", err)
	}
	events := srv.oom.since(0)
	var got []string
	for _, e := range events {
		got = append(got, e.BotKey)
	}
	want := []string{"bot-example-one", "agent-test", "bot-example-two"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("oom events for bots %v, want %v", got, want)
	}
}

package policy

import (
	"testing"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/jsonx"
)

// 1.6.6 DEVBUILD-ISOLATION: the driver may append DEVBUILD_BOT_NAME=<bot key> to the three
// DEVBUILD_* entries of a dev-variant bot body; any other value or position is denied.
func TestParseBotEnvDevbuildBotName(t *testing.T) {
	const botKey = "agent-a"
	three := `"DEVBUILD_HOST=build-host.internal","DEVBUILD_USER=devbuild","DEVBUILD_BASE=/srv/devbuild"`
	cases := []struct {
		name   string
		env    string
		botKey string
		ok     bool
	}{
		{"three entries", `[` + three + `]`, botKey, true},
		{"three plus own bot name", `[` + three + `,"DEVBUILD_BOT_NAME=` + botKey + `"]`, botKey, true},
		{"other bot's name", `[` + three + `,"DEVBUILD_BOT_NAME=agent-b"]`, botKey, false},
		{"empty bot name", `[` + three + `,"DEVBUILD_BOT_NAME="]`, botKey, false},
		{"route without key", `[` + three + `,"DEVBUILD_BOT_NAME="]`, "", false},
		{"bot name first", `["DEVBUILD_BOT_NAME=` + botKey + `",` + three + `]`, botKey, false},
		{"unknown fourth", `[` + three + `,"OTHER=1"]`, botKey, false},
		{"bot name alone", `["DEVBUILD_BOT_NAME=` + botKey + `"]`, botKey, false},
	}
	for _, c := range cases {
		v, perr := jsonx.Parse([]byte(c.env))
		if perr != nil {
			t.Fatalf("%s: parse: %v", c.name, perr)
		}
		got, err := parseBotEnv(v, "Env", c.botKey)
		if c.ok && err != nil {
			t.Errorf("%s: denied, want allowed: %v", c.name, err)
		}
		if !c.ok && err == nil {
			t.Errorf("%s: allowed %v, want denied", c.name, got)
		}
	}
}

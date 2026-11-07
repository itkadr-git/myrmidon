package gate

import (
	"encoding/json"
	"net/http"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/route"
)

// a20 updates one enrolled bot's resource limits in dockergate's own config.
// Caller authentication and pin checks have already run in Gate.handle.
func (rs *reqState) a20(st *runtime, rt *route.Route) *deny.Error {
	if rs.g.opt.ConfigPath == "" {
		return deny.New(deny.RouteNotAllowed).WithDetail("config_path_disabled")
	}
	if rt.ConfigBotKey == "" {
		return deny.New(deny.RouteNotAllowed).WithDetail("target_bot_required")
	}
	body, derr := rs.readBody(st.cfg.Limits.MaxJSONBody, "application/json", deny.JSONSyntax)
	if derr != nil {
		return derr
	}
	u, err := config.DecodeBotUpdate(body)
	if err != nil {
		return deny.New(deny.JSONSyntax).WithDetail("config_update")
	}
	if rt.ConfigBotKey != "" {
		if u.BotKey == "" {
			u.BotKey = rt.ConfigBotKey
		} else if u.BotKey != rt.ConfigBotKey {
			return deny.New(deny.BotNotEnrolled)
		}
	}

	g := rs.g
	g.configMu.Lock()
	defer g.configMu.Unlock()
	current := g.st.Load()
	next := current.cfg.Clone()
	if err := config.ApplyBotUpdate(next, u); err != nil {
		return deny.New(deny.LimitExceedsCeiling).WithDetail(err.Error())
	}
	if err := config.WriteAtomic(g.opt.ConfigPath, next); err != nil {
		g.log.Write(Line{Level: LevelError, Event: "config_update_failed", Detail: "write"})
		return deny.New(deny.UpstreamError).WithDetail("config_write")
	}
	loaded, hash, err := config.Load(g.opt.ConfigPath)
	if err != nil {
		g.log.Write(Line{Level: LevelError, Event: "config_update_failed", Detail: "reload_invalid"})
		return deny.New(deny.UpstreamError).WithDetail("config_reload")
	}
	if !reloadable(current.cfg, loaded) {
		g.log.Write(Line{Level: LevelError, Event: "config_update_failed", Detail: "restart_required"})
		return deny.New(deny.UpstreamError).WithDetail("config_restart_required")
	}
	g.st.Store(newRuntime(loaded, hash))
	g.imgMu.Lock()
	g.imgs = nil
	g.imgMu.Unlock()
	g.log.Write(Line{Event: "config_updated", BotKey: u.BotKey, ConfigHash: hash})
	resp, err := json.Marshal(struct {
		OK     bool    `json:"ok"`
		BotKey string  `json:"botKey"`
		Memory int64   `json:"memoryMb"`
		CPUs   float64 `json:"cpus"`
		Pids   int64   `json:"pidsLimit"`
	}{true, u.BotKey, u.MemoryMB, u.CPUs, u.PidsLimit})
	if err != nil {
		return deny.New(deny.UpstreamError).WithDetail("config_response")
	}
	rs.respond(&answer{status: http.StatusOK, ctype: jsonType, body: resp})
	return nil
}

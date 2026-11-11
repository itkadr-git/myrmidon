package gate

import (
	"encoding/json"
	"errors"
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
	// OPE-12383: when "limitsOverrideFile" is configured, the update goes to
	// that file (the mutable per-bot limits only) and the main config file —
	// often mounted read-only into the container — is never written. Without
	// the override the behaviour is as before: the main file is rewritten.
	if override := current.cfg.LimitsOverrideFile; override != "" {
		bots, err := config.LoadLimitsOverride(override)
		if err != nil {
			g.log.Write(Line{Level: LevelError, Event: "config_update_failed", Detail: "override_invalid"})
			return deny.New(deny.ConfigReadOnly).WithDetail("override_invalid")
		}
		// The entry is the post-update state of the bot (ApplyBotUpdate has
		// already validated the values and ratcheted the ceilings in next):
		// the override carries the applied limits AND the ceilings, so later
		// updates stay bound by the first update's pin.
		entry := config.OverrideBot{BotKey: u.BotKey}
		for _, b := range next.Bots {
			if b.BotKey == u.BotKey {
				entry = config.OverrideBot{
					BotKey:          b.BotKey,
					MemoryMB:        b.MaxMemoryMB,
					CPUs:            b.MaxCPUs,
					PidsLimit:       b.MaxPids,
					CeilingMemoryMB: b.CeilingMemoryMB,
					CeilingCPUs:     b.CeilingCPUs,
					CeilingPids:     b.CeilingPids,
				}
				break
			}
		}
		merged := make([]config.OverrideBot, 0, len(bots)+1)
		replaced := false
		for _, ob := range bots {
			if ob.BotKey == u.BotKey {
				merged = append(merged, entry)
				replaced = true
				continue
			}
			merged = append(merged, ob)
		}
		if !replaced {
			merged = append(merged, entry)
		}
		if err := config.WriteLimitsOverride(override, merged); err != nil {
			g.log.Write(Line{Level: LevelError, Event: "config_update_failed", Detail: "override_write"})
			var ro *config.ReadOnlyError
			if errors.As(err, &ro) {
				return deny.New(deny.ConfigReadOnly).WithDetail("override_write")
			}
			return deny.New(deny.UpstreamError).WithDetail("override_write")
		}
		loaded, hash, err := config.LoadForRuntime(g.opt.ConfigPath)
		if err != nil {
			g.log.Write(Line{Level: LevelError, Event: "config_update_failed", Detail: "reload_invalid"})
			return deny.New(deny.ConfigReadOnly).WithDetail("override_reload")
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

// a21 answers route A21 (GET one bot's limits) with the bot's dockergate-side
// resource limits AND the platform ceilings that bound them. The board uses it
// (OPE-12337) to validate an agent card's container.memoryMb/cpus/pidsLimit
// against the same ceilings dockergate enforces on HostConfig, so a card that
// the gate would reject at reconcile time is rejected at save time with 422.
// Read-only: no daemon call, no config write.
func (rs *reqState) a21(st *runtime, rt *route.Route) *deny.Error {
	if rt.ConfigBotKey == "" {
		return deny.New(deny.RouteNotAllowed).WithDetail("target_bot_required")
	}
	bot, found := st.cfg.Bot(rt.ConfigBotKey)
	if !found {
		return deny.New(deny.BotNotEnrolled)
	}
	ceilMem, ceilCPUs, ceilPids, _ := st.cfg.CeilingsFor(rt.ConfigBotKey)
	resp, err := json.Marshal(struct {
		OK              bool    `json:"ok"`
		BotKey          string  `json:"botKey"`
		Memory          int64   `json:"memoryMb"`
		CPUs            float64 `json:"cpus"`
		Pids            int64   `json:"pidsLimit"`
		CeilingMemory   int64   `json:"ceilingMemoryMb"`
		CeilingCPUs     float64 `json:"ceilingCpus"`
		CeilingPids     int64   `json:"ceilingPids"`
		EffectiveMemory int64   `json:"effectiveMemoryMb"`
		EffectiveCPUs   float64 `json:"effectiveCpus"`
		EffectivePids   int64   `json:"effectivePidsLimit"`
	}{true, bot.BotKey, bot.MaxMemoryMB, bot.MaxCPUs, bot.MaxPids, ceilMem, ceilCPUs, ceilPids,
		min(bot.MaxMemoryMB, ceilMem), min(bot.MaxCPUs, ceilCPUs), min(bot.MaxPids, ceilPids)})
	if err != nil {
		return deny.New(deny.UpstreamError).WithDetail("bot_limits_json")
	}
	rs.respond(&answer{status: http.StatusOK, ctype: jsonType, body: resp})
	return nil
}

package gate

import (
	"context"
	"net/http"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/disk"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/route"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/upstream"
)

// a22: the decommission delete of a bot's main container (OPE-12654). The
// agent left the bot runtime (its card moved to another adapter, or it was
// terminated or deleted), so the main container goes without the `.next`
// replacement that A9 requires, and the bot's quota project and data directory
// go with it.
//
// The main container must be ours and stopped (created, exited, dead): the
// board stops it first with the idle-stop route (A17), which refuses a stop in
// the middle of a recreate or next to a running helper. A `.next` or a helper of
// the same bot that runs blocks the delete. One that does not run is a leftover
// of an interrupted recreate or apply: it is deleted first, so no container of
// the bot outlives the decommission (the board never asks for them again).
//
// The data directory <volumeRoot>/<botKey> is removed after the main container,
// and only when the daemon confirmed that delete. Its removal fails soft: the
// delete is already answered, a failure is logged as bot_data_remove_failed
// with a fixed reason (read_only when the volume root is mounted read-only,
// permission when the gate may not delete there), and the directory stays for
// the operator. The quota project is removed last: Quota.Remove refuses while
// the directory still exists.
func (rs *reqState) a22(ctx context.Context, st *runtime, rt *route.Route, bs *botState) *deny.Error {
	def, _, _ := rs.timeouts()
	unlock, derr := rs.g.lockBot(ctx, bs)
	if derr != nil {
		return derr
	}
	defer unlock()

	ct, derr := rs.inspectOurs(ctx, rt.BotKey, route.SuffixMain)
	if derr != nil {
		return derr
	}
	if ct == nil {
		return rs.notFound()
	}
	switch ct.Status() {
	case "created", "exited", "dead":
	default:
		return statePrecondition("main_running")
	}
	next, derr := rs.inspectOurs(ctx, rt.BotKey, route.SuffixNext)
	if derr != nil {
		return derr
	}
	if next != nil && next.Status() == "running" {
		return statePrecondition("next_running")
	}
	helper, derr := rs.inspectOurs(ctx, rt.BotKey, route.SuffixHelper)
	if derr != nil {
		return derr
	}
	if helper != nil && helper.Status() == "running" {
		return statePrecondition("helper_running")
	}
	if derr := rs.g.allow(bs, rateStop); derr != nil {
		return derr
	}

	// The leftovers first: a failure here leaves the main container in place,
	// so the board sees the error and asks again on its next sweep.
	for _, left := range []*upstream.Container{next, helper} {
		if left == nil {
			continue
		}
		ans, derr := rs.call(ctx, upstream.Request{Method: "DELETE", Target: containerPath(left.ID, "?force=true&v=true")},
			def, maxErrBody, deny.ResponseTooLarge)
		if derr != nil {
			return derr
		}
		if ans.status != http.StatusNotFound && (ans.status < 200 || ans.status >= 300) {
			rs.respond(ans)
			return nil
		}
	}

	ans, derr := rs.call(ctx, upstream.Request{Method: "DELETE", Target: containerPath(ct.ID, "?force=true&v=true")},
		def, maxErrBody, deny.ResponseTooLarge)
	if derr != nil {
		return derr
	}
	rs.respond(ans)
	if ans.status < 200 || ans.status >= 300 {
		return nil
	}

	removed, err := disk.RemoveBotData(st.cfg.VolumeRoot, rt.BotKey)
	switch {
	case err != nil:
		rs.g.log.Write(Line{Level: LevelError, Event: "bot_data_remove_failed", BotKey: rt.BotKey, Reason: "decommission", Detail: disk.BotDataFailure(err)})
	case removed:
		rs.g.log.Write(Line{Event: "bot_data_removed", BotKey: rt.BotKey, Reason: "decommission"})
	default:
		rs.g.log.Write(Line{Event: "bot_data_removed", BotKey: rt.BotKey, Reason: "decommission", Detail: "absent"})
	}

	cleanupCtx, cancel := context.WithTimeout(ctx, def)
	err = rs.g.opt.Disk.Remove(cleanupCtx, rt.BotKey)
	cancel()
	if err != nil {
		rs.g.log.Write(Line{Level: LevelError, Event: "disk_project_remove_failed", BotKey: rt.BotKey, Reason: "decommission"})
	} else {
		rs.g.log.Write(Line{Event: "disk_project_removed", BotKey: rt.BotKey})
	}
	return nil
}

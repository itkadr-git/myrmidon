package gate

import (
	"context"
	"net/http"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/route"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/upstream"
)

// a22: the decommission delete of a bot's main container (OPE-12654). The
// agent left the bot runtime (its card moved to another adapter, or it was
// terminated or deleted), so the main container goes without the `.next`
// replacement that A9 requires, and the bot's quota project goes with it.
//
// The main container must be ours and stopped (created, exited, dead): the
// board stops it first with the idle-stop route (A17), which refuses a stop in
// the middle of a recreate or next to a running helper. A `.next` or a helper of
// the same bot that runs blocks the delete. One that does not run is a leftover
// of an interrupted recreate or apply: it is deleted first, so no container of
// the bot outlives the decommission (the board never asks for them again).
//
// The data directory <volumeRoot>/<botKey> is not removed here: the gate runs
// as uid 65532 and holds the volume root read-only, so it cannot remove it
// (the ADM hand-off of 11.11). The host GC (scripts/myrmidon/host-gc/) owns the
// removal instead: it deletes the directory of a bot with no main container
// after the retention delay, and only when the bot's clones hold no unpushed
// work. The gate answers the delete without touching the directory and logs
// `bot_data_left_for_host_gc`.
//
// The quota project waits too: Quota.Remove refuses while the directory still
// exists, so the attempt here fails with `disk_project_still_has_directory`
// and logs `quota_left_for_host_gc` — a flow event, not an error: the same
// pass that removes the directory clears the entries after it.
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

	// The data directory stays (see the comment above): the host GC owns it.
	// Say so once, with a fixed name, so the operator knows the directory is
	// not lost — it is owned by the host pass.
	rs.g.log.Write(Line{Event: "bot_data_left_for_host_gc", BotKey: rt.BotKey, Reason: "decommission"})

	// The quota project waits for the same host pass (see the comment above):
	// Quota.Remove refuses while the directory exists.
	cleanupCtx, cancel := context.WithTimeout(ctx, def)
	err := rs.g.opt.Disk.Remove(cleanupCtx, rt.BotKey)
	cancel()
	if err != nil {
		rs.g.log.Write(Line{Level: LevelInfo, Event: "disk_project_still_has_directory", BotKey: rt.BotKey, Reason: "decommission"})
		rs.g.log.Write(Line{Event: "quota_left_for_host_gc", BotKey: rt.BotKey})
	} else {
		rs.g.log.Write(Line{Event: "disk_project_removed", BotKey: rt.BotKey})
	}
	return nil
}

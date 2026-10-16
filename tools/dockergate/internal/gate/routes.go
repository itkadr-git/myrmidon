package gate

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/config"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/disk"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/policy"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/route"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/upstream"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/ustar"
)

// The flows below follow the table of spec 6.1 and 9.1. In each one the order
// is the same: what needs no state (the body), then the lock, then the
// inspect and the preconditions, then the rate, then the call.

func statePrecondition(detail string) *deny.Error {
	return deny.New(deny.StatePrecondition).WithDetail(detail)
}

// a1: the image inspect, trimmed to the labels.
func (rs *reqState) a1(ctx context.Context, st *runtime, rt *route.Route) *deny.Error {
	def, _, _ := rs.timeouts()
	ans, derr := rs.call(ctx, upstream.Request{
		Method: "GET",
		Target: upstream.Prefix + "/images/" + route.NameSegment(rt.ImageRef) + "/json",
	}, def, maxInspectA, deny.ResponseTooLarge)
	if derr != nil {
		return derr
	}
	if ans.status == http.StatusOK {
		body, derr := upstream.TrimImage(ans.body)
		if derr != nil {
			return derr
		}
		ans.body, ans.ctype = body, jsonType
	}
	rs.respond(ans)
	return nil
}

// a2: the container inspect, trimmed to what the driver reads.
func (rs *reqState) a2(ctx context.Context, st *runtime, rt *route.Route, bs *botState) *deny.Error {
	if derr := rs.g.allow(bs, rateInspect); derr != nil {
		return derr
	}
	ct, derr := rs.inspectOurs(ctx, rt.BotKey, route.SuffixMain)
	if derr != nil {
		return derr
	}
	if ct == nil {
		return rs.notFound()
	}
	rs.upstream = http.StatusOK
	rs.respond(&answer{status: http.StatusOK, ctype: jsonType, body: ct.Trimmed()})
	return nil
}

// markerPath is the query of the archive GET of the applied marker of an
// isolated bot.
const markerPath = "/archive?" + route.MarkerQuery

// legacyMarkerPath is the applied marker of a LEGACY-layout bot (contract "1"),
// read through its /data/hermes bind.
const legacyMarkerPath = "/archive?" + route.LegacyMarkerQuery

// a3: the applied marker. A marker of more than 1 MiB is reported as absent.
func (rs *reqState) a3(ctx context.Context, st *runtime, rt *route.Route, bs *botState) *deny.Error {
	target := markerPath
	if rt.LegacyMarker {
		target = legacyMarkerPath
	} else if rt.ScopeMarker {
		target = "/archive?" + route.ScopeMarkerQuery(rt.BotKey)
	}
	return rs.archiveRead(ctx, rt, bs, target, maxMarker)
}

// cloneReportPath is the query of the archive GET of the clone-hygiene report.
const cloneReportPath = "/archive?" + route.CloneReportQuery

// legacyCloneReportPath is the clone-hygiene report of a LEGACY-layout bot.
const legacyCloneReportPath = "/archive?" + route.LegacyCloneReportQuery

// a13: the clone-hygiene report of the bot, one fixed file, read-only.
func (rs *reqState) a13(ctx context.Context, st *runtime, rt *route.Route, bs *botState) *deny.Error {
	target := cloneReportPath
	if rt.LegacyMarker {
		target = legacyCloneReportPath
	} else if rt.ScopeMarker {
		target = "/archive?" + route.ScopeCloneReportQuery(rt.BotKey)
	}
	return rs.archiveRead(ctx, rt, bs, target, maxCloneReport)
}

// archiveRead reads one fixed file of the main container as a tar.
func (rs *reqState) archiveRead(ctx context.Context, rt *route.Route, bs *botState, query string, limit int) *deny.Error {
	if derr := rs.g.allow(bs, rateInspect); derr != nil {
		return derr
	}
	ct, derr := rs.inspectOurs(ctx, rt.BotKey, route.SuffixMain)
	if derr != nil {
		return derr
	}
	if ct == nil {
		return rs.notFound()
	}
	def, _, _ := rs.timeouts()
	ans, derr := rs.call(ctx, upstream.Request{Method: "GET", Target: containerPath(ct.ID, query)},
		def, limit, deny.MarkerTooLarge)
	if derr != nil {
		return derr
	}
	rs.respond(ans)
	return nil
}

// a4: create. The body is parsed and rebuilt; the daemon gets the rebuilt one.
func (rs *reqState) a4(ctx context.Context, st *runtime, rt *route.Route, bot config.Bot, bs *botState) *deny.Error {
	def, _, _ := rs.timeouts()
	body, derr := rs.readBody(st.cfg.Limits.MaxJSONBody, "application/json", deny.JSONSyntax)
	if derr != nil {
		return derr
	}
	env := &policy.Env{
		VolumeRoot:       st.cfg.VolumeRoot,
		Network:          st.cfg.Network,
		Images:           st.set,
		MountSources:     st.cfg.MountSources,
		PackageCacheRoot: st.cfg.PackageCacheRoot,
		BotRuntimeRoot:   st.cfg.BotRuntimeRoot,
		ScopeRoot:        st.cfg.EffectiveScopeRoot(),
		ScopeInstances:   bot.ScopeInstances,
		MaxMemoryMB:      bot.MaxMemoryMB,
		MaxCPUs:          bot.MaxCPUs,
		MaxPids:          bot.MaxPids,
	}
	cr, derr := policy.ParseCreate(body, rt, env)
	if derr != nil {
		return derr
	}

	// The image self-check (spec 7.5). An image that does not exist is passed
	// on: the daemon answers 404, as the driver expects.
	var img *policy.ImageInfo
	if cr.Form == policy.FormHelperApply {
		img, derr = rs.g.imageByID(ctx, st, cr.Image)
		if derr != nil {
			return derr
		}
		if img == nil {
			return deny.Field(deny.ImageNotAllowed, "Image", []byte(cr.Image))
		}
	} else {
		img, _, derr = rs.g.up.InspectImage(ctx, route.NameSegment(cr.Image))
		if derr != nil {
			return derr
		}
	}
	if img != nil {
		if derr := policy.CheckImage(img); derr != nil {
			return derr
		}
	}
	if derr := policy.CheckVolumeRoot(rs.g.lstat, st.cfg.VolumeRoot, rt.BotKey); derr != nil {
		return derr
	}
	if cr.ScopeInstance != "" {
		if derr := policy.CheckScopeDir(rs.g.lstat, st.cfg.EffectiveScopeRoot(), cr.ScopeInstance, rt.BotKey); derr != nil {
			return derr
		}
	}

	unlock, derr := rs.g.lockBot(ctx, bs)
	if derr != nil {
		return derr
	}
	defer unlock()

	switch {
	case cr.Form == policy.FormBot && rt.Suffix == route.SuffixNext:
		main, derr := rs.inspectOurs(ctx, rt.BotKey, route.SuffixMain)
		if derr != nil {
			return derr
		}
		if main == nil {
			return statePrecondition("main_missing")
		}
	case cr.Form == policy.FormHelperApply:
		main, derr := rs.inspectOurs(ctx, rt.BotKey, route.SuffixMain)
		if derr != nil {
			return derr
		}
		if main == nil {
			return statePrecondition("main_missing")
		}
		if main.Image != cr.Image {
			return deny.Field(deny.HelperImageMismatch, "Image", []byte(cr.Image))
		}
	}
	if derr := rs.g.allow(bs, rateCreate); derr != nil {
		return derr
	}
	ans, derr := rs.call(ctx, upstream.Request{
		Method:      "POST",
		Target:      upstream.Prefix + "/containers/create?name=" + rt.Name,
		Body:        cr.Body,
		ContentType: jsonType,
	}, def, maxCreateRes, deny.ResponseTooLarge)
	if derr != nil {
		return derr
	}
	if ans.status == http.StatusCreated || ans.status == http.StatusOK {
		trimmed, derr := upstream.TrimCreate(ans.body)
		if derr != nil {
			return derr
		}
		ans.body, ans.ctype = trimmed, jsonType
	}
	rs.respond(ans)
	return nil
}

// a5: the tar upload into an apply helper.
func (rs *reqState) a5(ctx context.Context, st *runtime, rt *route.Route, bs *botState) *deny.Error {
	def, _, _ := rs.timeouts()
	body, derr := rs.readBody(st.cfg.Limits.MaxTarBody, "application/x-tar", deny.TarSyntax)
	if derr != nil {
		return derr
	}
	unlock, derr := rs.g.lockBot(ctx, bs)
	if derr != nil {
		return derr
	}
	defer unlock()

	ct, derr := rs.inspectOurs(ctx, rt.BotKey, route.SuffixHelper)
	if derr != nil {
		return derr
	}
	if ct == nil {
		return rs.notFound()
	}
	if ct.Status() != "created" {
		return statePrecondition("helper_not_created")
	}
	if ct.Config.User != policy.BotUser || len(ct.Config.Cmd) == 0 {
		return statePrecondition("helper_role")
	}
	nonce, derr := policy.ExtractNonce(ct.Config.Cmd[0])
	if derr != nil {
		return statePrecondition("helper_script")
	}
	res, derr := ustar.Validate(body, rt.Mount, nonce)
	if derr != nil {
		return derr
	}
	if derr := rs.g.allow(bs, ratePut); derr != nil {
		return derr
	}
	target := containerPath(ct.ID, "/archive?path="+strings.ReplaceAll(rt.Mount, "/", "%2F")+"&noOverwriteDirNonDir=true")
	ans, derr := rs.call(ctx, upstream.Request{
		Method: "PUT", Target: target, Body: res.Canonical, ContentType: "application/x-tar",
	}, def, maxErrBody, deny.ResponseTooLarge)
	if derr != nil {
		return derr
	}
	rs.respond(ans)
	return nil
}

// a6: start of the main container or of a helper.
func (rs *reqState) a6(ctx context.Context, st *runtime, rt *route.Route, bs *botState) *deny.Error {
	def, _, _ := rs.timeouts()
	unlock, derr := rs.g.lockBot(ctx, bs)
	if derr != nil {
		return derr
	}
	defer unlock()

	ct, derr := rs.inspectOurs(ctx, rt.BotKey, rt.Suffix)
	if derr != nil {
		return derr
	}
	if ct == nil {
		return rs.notFound()
	}
	if rt.Suffix == route.SuffixHelper && ct.Status() != "created" {
		return statePrecondition("helper_not_created")
	}
	if derr := rs.g.allow(bs, rateStart); derr != nil {
		return derr
	}
	ans, derr := rs.call(ctx, upstream.Request{Method: "POST", Target: containerPath(ct.ID, "/start")},
		def, maxErrBody, deny.ResponseTooLarge)
	if derr != nil {
		return derr
	}
	rs.respond(ans)
	return nil
}

// a7: the wait of a helper. The headers go out at once and the body follows as
// the daemon sends it (spec 10).
func (rs *reqState) a7(ctx context.Context, st *runtime, rt *route.Route) *deny.Error {
	ct, derr := rs.inspectOurs(ctx, rt.BotKey, route.SuffixHelper)
	if derr != nil {
		return derr
	}
	if ct == nil {
		return rs.notFound()
	}
	_, _, wait := rs.timeouts()
	cctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	res, derr := rs.g.up.Do(cctx, upstream.Request{
		Method: "POST", Target: containerPath(ct.ID, "/wait?condition=not-running"),
	})
	if derr != nil {
		return derr
	}
	defer res.Body.Close()
	if res.Status < 200 || res.Status > 599 {
		return deny.New(deny.UpstreamError).WithDetail("status")
	}
	rs.upstream = res.Status

	h := rs.w.Header()
	if ctype := safeContentType(res.Header.Get("Content-Type")); ctype != "" {
		h.Set("Content-Type", ctype)
	}
	rs.w.WriteHeader(res.Status)
	rc := http.NewResponseController(rs.w)
	_ = rc.Flush()

	buf := make([]byte, 4096)
	total := 0
	for {
		n, err := res.Body.Read(buf)
		if n > 0 {
			total += n
			if total > maxWaitBody {
				rs.abort(deny.New(deny.ResponseTooLarge))
			}
			if _, werr := rs.w.Write(buf[:n]); werr != nil {
				rs.abort(deny.New(deny.UpstreamError).WithDetail("client_write"))
			}
			rs.respBytes += int64(n)
			_ = rc.Flush()
		}
		if err == nil {
			continue
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if errors.Is(cctx.Err(), context.DeadlineExceeded) {
			rs.abort(deny.New(deny.UpstreamTimeout))
		}
		rs.abort(deny.New(deny.UpstreamError).WithDetail("read"))
	}
}

// a8: the last lines of the log of a helper.
func (rs *reqState) a8(ctx context.Context, st *runtime, rt *route.Route, bs *botState) *deny.Error {
	ct, derr := rs.inspectOurs(ctx, rt.BotKey, route.SuffixHelper)
	if derr != nil {
		return derr
	}
	if ct == nil {
		return rs.notFound()
	}
	def, _, _ := rs.timeouts()
	ans, derr := rs.call(ctx, upstream.Request{
		Method: "GET", Target: containerPath(ct.ID, "/logs?stdout=true&stderr=true&tail=20"),
	}, def, maxLogsBody, deny.ResponseTooLarge)
	if derr != nil {
		return derr
	}
	rs.respond(ans)
	return nil
}

// a9: delete. A helper or a .next container needs only to be ours; the main
// container also needs to be stopped and to have its replacement ready.
func (rs *reqState) a9(ctx context.Context, st *runtime, rt *route.Route, bs *botState) *deny.Error {
	def, _, _ := rs.timeouts()
	unlock, derr := rs.g.lockBot(ctx, bs)
	if derr != nil {
		return derr
	}
	defer unlock()

	ct, derr := rs.inspectOurs(ctx, rt.BotKey, rt.Suffix)
	if derr != nil {
		return derr
	}
	if ct == nil {
		return rs.notFound()
	}
	if rt.Suffix == route.SuffixMain {
		switch ct.Status() {
		case "created", "exited", "dead":
		default:
			return statePrecondition("main_running")
		}
		if derr := rs.requireNextCreated(ctx, rt.BotKey); derr != nil {
			return derr
		}
		if derr := rs.g.allow(bs, rateStop); derr != nil {
			return derr
		}
	}
	ans, derr := rs.call(ctx, upstream.Request{Method: "DELETE", Target: containerPath(ct.ID, "?force=true&v=true")},
		def, maxErrBody, deny.ResponseTooLarge)
	if derr != nil {
		return derr
	}
	rs.respond(ans)
	return nil
}

// requireNextCreated checks that the .next container of the bot is ours and
// has not been started.
func (rs *reqState) requireNextCreated(ctx context.Context, key string) *deny.Error {
	next, derr := rs.inspectOurs(ctx, key, route.SuffixNext)
	if derr != nil {
		return derr
	}
	if next == nil {
		return statePrecondition("next_missing")
	}
	if next.Status() != "created" {
		return statePrecondition("next_not_created")
	}
	return nil
}

// a10: stop, only inside a recreate.
func (rs *reqState) a10(ctx context.Context, st *runtime, rt *route.Route, bs *botState) *deny.Error {
	_, stop, _ := rs.timeouts()
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
	if derr := rs.requireNextCreated(ctx, rt.BotKey); derr != nil {
		return derr
	}
	if derr := rs.g.allow(bs, rateStop); derr != nil {
		return derr
	}
	ans, derr := rs.call(ctx, upstream.Request{Method: "POST", Target: containerPath(ct.ID, "/stop?t=30")},
		stop, maxErrBody, deny.ResponseTooLarge)
	if derr != nil {
		return derr
	}
	rs.respond(ans)
	return nil
}

// a11: restart of the main container.
func (rs *reqState) a11(ctx context.Context, st *runtime, rt *route.Route, bs *botState) *deny.Error {
	_, stop, _ := rs.timeouts()
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
	if derr := rs.g.allow(bs, rateRestart); derr != nil {
		return derr
	}
	ans, derr := rs.call(ctx, upstream.Request{Method: "POST", Target: containerPath(ct.ID, "/restart?t=30")},
		stop, maxErrBody, deny.ResponseTooLarge)
	if derr != nil {
		return derr
	}
	rs.respond(ans)
	return nil
}

// a12: the rename of .next to the main name, once the main container is gone.
func (rs *reqState) a12(ctx context.Context, st *runtime, rt *route.Route, bs *botState) *deny.Error {
	def, _, _ := rs.timeouts()
	unlock, derr := rs.g.lockBot(ctx, bs)
	if derr != nil {
		return derr
	}
	defer unlock()

	next, derr := rs.inspectOurs(ctx, rt.BotKey, route.SuffixNext)
	if derr != nil {
		return derr
	}
	if next == nil {
		return rs.notFound()
	}
	if next.Status() != "created" {
		return statePrecondition("next_not_created")
	}
	main, _, derr := rs.g.up.Inspect(ctx, route.NameOf(rt.BotKey, route.SuffixMain))
	if derr != nil {
		return derr
	}
	if main != nil {
		return statePrecondition("main_exists")
	}
	if derr := rs.g.allow(bs, rateStop); derr != nil {
		return derr
	}
	ans, derr := rs.call(ctx, upstream.Request{
		Method: "POST",
		Target: containerPath(next.ID, "/rename?name="+route.NameOf(rt.BotKey, route.SuffixMain)),
	}, def, maxErrBody, deny.ResponseTooLarge)
	if derr != nil {
		return derr
	}
	rs.respond(ans)
	return nil
}

// a14: GET /myrmidon/disk. The partition (statfs of the volume root) and the
// project quotas (`xfs_quota report`), never a call to the daemon. A partition
// without prjquota is a normal answer (quotaEnabled=false), not an error; what
// is an error is a volume root that cannot be read or a report that cannot be
// understood, and a command that does not finish in time.
func (rs *reqState) a14(ctx context.Context, st *runtime) *deny.Error {
	def, _, _ := rs.timeouts()
	cctx, cancel := context.WithTimeout(ctx, def)
	defer cancel()
	resp, err := disk.Collect(cctx, st.cfg.VolumeRoot, rs.g.disk)
	switch {
	case err == nil:
	case errors.Is(err, context.DeadlineExceeded):
		return deny.New(deny.UpstreamTimeout).WithDetail("xfs_quota")
	case errors.Is(err, disk.ErrStatfs):
		return deny.New(deny.UpstreamError).WithDetail("statfs")
	case errors.Is(err, disk.ErrReport):
		return deny.New(deny.UpstreamError).WithDetail("xfs_report")
	default:
		return deny.New(deny.UpstreamError).WithDetail("disk")
	}
	body, err := json.Marshal(resp)
	if err != nil {
		return deny.New(deny.UpstreamError).WithDetail("disk_json")
	}
	rs.respond(&answer{status: http.StatusOK, ctype: jsonType, body: body})
	return nil
}

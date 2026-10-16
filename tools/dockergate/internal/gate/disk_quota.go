package gate

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/disk"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/jsonx"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/route"
)

// quotaKey is the one key of the body of A15 (wsDiskQuotaPutRequestSchema).
const quotaKey = "bytes"

// parseQuotaBody reads {"bytes": <integer>} and checks the bounds of the
// contract. A number that the strict parser refuses as too large is out of the
// bounds as well, so it is bad_quota like any other number outside them.
func parseQuotaBody(body []byte) (int64, *deny.Error) {
	v, derr := jsonx.Parse(body)
	if derr != nil {
		if derr.Code == deny.JSONValue && derr.Detail == "integer_range" {
			return 0, deny.New(deny.BadQuota).WithDetail("range")
		}
		return 0, derr
	}
	if v.Kind != jsonx.KindObject {
		return 0, deny.FieldOnly(deny.JSONType, "$")
	}
	for _, m := range v.Members {
		if m.Key != quotaKey {
			return 0, deny.Field(deny.JSONUnknownKey, "$", []byte(m.Key))
		}
	}
	n := v.Get(quotaKey)
	if n == nil || n.Kind != jsonx.KindInt {
		return 0, deny.FieldOnly(deny.JSONType, quotaKey)
	}
	if !disk.ValidBytes(n.N) {
		return 0, deny.New(deny.BadQuota).WithDetail("range")
	}
	return n.N, nil
}

// a15: PUT /myrmidon/disk/<botKey>/quota. The answer is written by dockergate
// itself (wsDiskQuotaPutResponseSchema); the daemon is not called.
func (rs *reqState) a15(ctx context.Context, st *runtime, rt *route.Route) *deny.Error {
	body, derr := rs.readBody(st.cfg.Limits.MaxJSONBody, "application/json", deny.JSONSyntax)
	if derr != nil {
		return derr
	}
	hard, derr := parseQuotaBody(body)
	if derr != nil {
		return derr
	}
	def, _, _ := rs.timeouts()
	cctx, cancel := context.WithTimeout(ctx, def)
	defer cancel()
	res, err := rs.g.opt.Disk.Put(cctx, rt.BotKey, hard)
	switch {
	case err == nil:
	case errors.Is(err, disk.ErrQuotaUnavailable):
		return deny.New(deny.QuotaUnavailable)
	case errors.Is(err, disk.ErrBadQuota):
		return deny.New(deny.BadQuota)
	case errors.Is(err, disk.ErrBadKey):
		return deny.New(deny.RouteNotAllowed)
	case errors.Is(cctx.Err(), context.DeadlineExceeded):
		return deny.New(deny.UpstreamTimeout).WithDetail("disk")
	default:
		return deny.New(deny.UpstreamError).WithDetail("disk")
	}
	out := `{"ok":true,"projectId":` + strconv.Itoa(res.ProjectID) +
		`,"hardBytes":` + strconv.FormatInt(res.HardBytes, 10) + `}`
	rs.respond(&answer{status: http.StatusOK, ctype: jsonType, body: []byte(out)})
	return nil
}

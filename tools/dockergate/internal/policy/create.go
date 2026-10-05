package policy

import (
	"math"
	"strconv"
	"strings"

	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/deny"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/jsonx"
	"github.com/itkadr-git/myrmidon/tools/dockergate/internal/route"
)

// Form is the shape of a create body.
type Form uint8

const (
	// FormBot is the main container of a bot (M) and its replacement (M.next).
	FormBot Form = iota + 1
	// FormHelperPrepare is the root helper that fixes the owner of the three
	// volumes (M.helper, User 0:0).
	FormHelperPrepare
	// FormHelperApply is the helper that applies a profile (M.helper, User
	// 10001:10001).
	FormHelperApply
)

func (f Form) String() string {
	switch f {
	case FormBot:
		return "bot"
	case FormHelperPrepare:
		return "helper.prepare"
	case FormHelperApply:
		return "helper.apply"
	}
	return "unknown"
}

// Env is what the checks of a create body need from the configuration.
type Env struct {
	VolumeRoot string
	Network    string
	// Images is the set of allowed image references (repo@sha256:...).
	Images map[string]struct{}
	// MountSources are the host directories a bot may mount read-only on top of
	// its three volumes (configuration key "mountSources"). An empty list allows
	// no extra mount at all.
	MountSources []string
	// PackageCacheRoot is the host directory of the shared package cache
	// (configuration key "packageCacheRoot"). Empty allows no cache mount.
	PackageCacheRoot string
	// ScopeRoot is the host directory of shared isolation-scope instances
	// (configuration key "scopeRoot", BOT-DISK-F), and ScopeInstances the
	// instance directories THIS bot is enrolled for (bots[].scopeInstances).
	// With no enrolled instance a bot may only have its own isolated layout.
	ScopeRoot      string
	ScopeInstances []string
	// Ceilings of the bot the request is for.
	MaxMemoryMB int64
	MaxCPUs     float64
	MaxPids     int64
}

// Create is a create body that passed every check.
type Create struct {
	Form   Form
	BotKey string
	// Image is the reference (bot, prepare) or the image Id (apply).
	Image string
	// Nonce is N of an apply helper.
	Nonce string
	// ScopeInstance is the shared scope instance directory the body binds
	// ("" for the isolated layout). The caller checks the host directory.
	ScopeInstance string
	// Body is the canonical body: the bytes that go to the daemon.
	Body []byte
}

// BotMountTarget is where the single bind of a bot container appears. Inside
// it, hermes, workspace and scratch (and the pnpm store) are directories of ONE
// mount, so link(2) works between them; /data/hermes, /workspace and /scratch
// are links made by the image that resolve into it.
const BotMountTarget = "/bot"

// BotBind is the one bind of a bot container: its own directory under the
// volume root.
func BotBind(volumeRoot, botKey string) string {
	return volumeRoot + "/" + botKey + ":" + BotMountTarget
}

// ScopeMountTarget is where a member of a shared scope instance sees the ONE
// directory of the instance (BOT-DISK-F): the pnpm store and every member's
// hermes, workspace and scratch live in it, so a hard link works between any two
// of them. /data/hermes, /workspace and /scratch are links the entrypoint makes
// from a tmpfs over /data into this member's own subdirectory.
const ScopeMountTarget = "/bot-scope"

// ScopeSubdirEnv is the one environment variable a shared member's create body
// carries: its own subdirectory name (the bot key). Not a secret.
const ScopeSubdirEnv = "MYRMIDON_BOT_SCOPE_SUBDIR"

// ScopeDataTmpfs is the tmpfs over /data of a shared member, which holds only
// the links into its subdirectory. Owned by the bot, 1 MiB.
const ScopeDataTmpfs = "uid=10001,gid=10001,mode=0755,size=1m"

// ScopeHelperTarget is where the prepare helper of a shared member sees the
// instance directory, to hand it to the bot's uid.
const ScopeHelperTarget = "/scope"

// ScopeBind is the one bind of a shared member's bot container.
func ScopeBind(scopeRoot, instance string) string {
	return scopeRoot + "/" + instance + ":" + ScopeMountTarget
}

// ScopeHelperBinds are the binds of a helper of a shared member: the three
// narrow ones, now inside the member's own subdirectory of the instance
// directory, and (prepare only) the instance directory itself at /scope.
func ScopeHelperBinds(scopeRoot, instance, botKey string, withInstance bool) []string {
	base := scopeRoot + "/" + instance + "/" + botKey
	binds := []string{
		base + "/hermes:/data/hermes",
		base + "/workspace:/workspace",
		base + "/scratch:/scratch",
	}
	if withInstance {
		binds = append(binds, scopeRoot+"/"+instance+":"+ScopeHelperTarget)
	}
	return binds
}

// scopeEnrolled reports whether the bot may bind the instance.
func (e *Env) scopeEnrolled(instance string) bool {
	if e.ScopeRoot == "" {
		return false
	}
	for _, inst := range e.ScopeInstances {
		if inst == instance {
			return true
		}
	}
	return false
}

// Binds returns the three bind strings of a helper container: the per-bot
// directories, each at its own mount point. A helper only writes files and never
// needs a hard link, so it keeps the three narrow mounts; the bot container
// itself gets ONE mount (BotBind).
func Binds(volumeRoot, botKey string) []string {
	base := volumeRoot + "/" + botKey
	return []string{
		base + "/hermes:/data/hermes",
		base + "/workspace:/workspace",
		base + "/scratch:/scratch",
	}
}

// reservedTargets are the mount points a bot container owns: an extra mount may
// neither take one of them over nor shadow a path under it.
var reservedTargets = []string{"/bot", "/bot-scope", "/scope", "/data", "/data/hermes", "/workspace", "/scratch", "/tmp"}

// safeContainerTarget reports whether p may be the destination of an extra mount:
// a plain absolute path outside the reserved mount points.
func safeContainerTarget(p string) bool {
	if !strings.HasPrefix(p, "/") || p == "/" || strings.Contains(p, "..") ||
		strings.Contains(p, "//") || strings.HasSuffix(p, "/") || strings.Contains(p, "\x00") {
		return false
	}
	for _, r := range reservedTargets {
		if p == r || strings.HasPrefix(p, r+"/") {
			return false
		}
	}
	return true
}

// parseExtraBind splits "source:target:ro" or "source:target:rw", the two
// forms an extra mount may take. Only a shared package cache mount may be "rw"
// (see PackageCacheMounts); every other extra mount must be "ro".
func parseExtraBind(bind string) (source, target, mode string, ok bool) {
	parts := strings.Split(bind, ":")
	if len(parts) != 3 {
		return "", "", "", false
	}
	if parts[2] != "ro" && parts[2] != "rw" {
		return "", "", "", false
	}
	return parts[0], parts[1], parts[2], true
}

// PackageCacheMounts is the layout of the shared package cache: the
// subdirectory of env.PackageCacheRoot -> its mount point in the bot. It
// mirrors PACKAGE_CACHE_MOUNTS in server/src/myrmidon/bot-containers/template.ts.
// These are the only extra mounts that may be read-write, and only as exactly
// these pairs: a writable bind cannot name another source or another target.
var PackageCacheMounts = map[string]string{
	"pnpm":     "/cache/pnpm",
	"go-mod":   "/cache/go-mod",
	"go-build": "/cache/go-build",
	"gradle":   "/cache/gradle",
}

// PackageCacheReadOnlyMounts is the read-only part of the shared package
// cache: the board's bare git mirrors (myrmidon 1.6.2-BOT-DISK-C), which only
// the board writes and the bots clone from with --reference. It mirrors
// GIT_MIRROR_MOUNT in server/src/myrmidon/bot-containers/template.ts. These
// pairs are accepted only as "ro" (a "rw" bind of them is refused like any
// other writable bind) and need no mountSources entry.
var PackageCacheReadOnlyMounts = map[string]string{
	"git": "/cache/git",
}

// isPackageCacheBind reports whether source:target is one of the cache pairs
// under root. An empty root allows none.
func isPackageCacheBind(root, source, target string) bool {
	return isCachePair(PackageCacheMounts, root, source, target)
}

// isPackageCacheReadOnlyBind reports whether source:target is one of the
// read-only cache pairs under root. An empty root allows none.
func isPackageCacheReadOnlyBind(root, source, target string) bool {
	return isCachePair(PackageCacheReadOnlyMounts, root, source, target)
}

func isCachePair(pairs map[string]string, root, source, target string) bool {
	if root == "" || !strings.HasPrefix(source, root+"/") {
		return false
	}
	want, ok := pairs[strings.TrimPrefix(source, root+"/")]
	return ok && want == target
}

// parseBotBinds checks HostConfig.Binds: the one fixed bind first, then the bot's extra read-only mounts. Every extra source must be one
// of env.MountSources (exact match, no prefix rule — a card cannot reach a
// sibling directory the operator did not name) and every extra target must be a
// safe path used once. The one exception is the shared package cache: a "rw"
// bind is accepted only as one of the fixed pairs under env.PackageCacheRoot
// (isPackageCacheBind), and needs no mountSources entry; likewise the git
// mirrors, a "ro" bind accepted as the fixed pair under the same root
// (isPackageCacheReadOnlyBind). The returned list is what the daemon gets.
func parseBotBinds(v *jsonx.Value, path string, env *Env, botKey string, shared bool) ([]string, string, *deny.Error) {
	got, err := strList(v, path)
	if err != nil {
		return nil, "", err
	}
	if len(got) == 0 {
		return nil, "", deny.FieldOnly(deny.BindsMismatch, path)
	}
	// The first bind is the bot's own isolated directory, or, for a member of a
	// shared scope instance, the one instance directory it is enrolled for and
	// nothing broader: the instance name is read from the bind and must be one
	// of env.ScopeInstances, the bind is rebuilt from it byte for byte.
	instance := ""
	var base []string
	if shared {
		prefix := env.ScopeRoot + "/"
		const suffix = ":" + ScopeMountTarget
		if env.ScopeRoot == "" || !strings.HasPrefix(got[0], prefix) || !strings.HasSuffix(got[0], suffix) {
			return nil, "", deny.Field(deny.BindsMismatch, path, []byte(got[0]))
		}
		instance = strings.TrimSuffix(strings.TrimPrefix(got[0], prefix), suffix)
		if !env.scopeEnrolled(instance) || ScopeBind(env.ScopeRoot, instance) != got[0] {
			return nil, "", deny.Field(deny.MountSourceNotAllowed, path, []byte(got[0]))
		}
		base = []string{got[0]}
	} else {
		base = []string{BotBind(env.VolumeRoot, botKey)}
		if got[0] != base[0] {
			return nil, "", deny.Field(deny.BindsMismatch, path, []byte(got[0]))
		}
	}
	allowed := make(map[string]bool, len(env.MountSources))
	for _, src := range env.MountSources {
		allowed[src] = true
	}
	seen := make(map[string]bool, len(got)-len(base))
	extras := make([]string, 0, len(got)-len(base))
	for _, bind := range got[len(base):] {
		source, target, mode, ok := parseExtraBind(bind)
		if !ok {
			return nil, "", deny.Field(deny.BindsMismatch, path, []byte(bind))
		}
		if mode == "rw" {
			if !isPackageCacheBind(env.PackageCacheRoot, source, target) {
				return nil, "", deny.Field(deny.MountSourceNotAllowed, path, []byte(source))
			}
		} else if !allowed[source] && !isPackageCacheReadOnlyBind(env.PackageCacheRoot, source, target) {
			return nil, "", deny.Field(deny.MountSourceNotAllowed, path, []byte(source))
		}
		if !safeContainerTarget(target) || seen[target] {
			return nil, "", deny.Field(deny.BindsMismatch, path, []byte(target))
		}
		seen[target] = true
		extras = append(extras, bind)
	}
	return append(base, extras...), instance, nil
}

// ParseCreate checks a create body against the schema of the form that the
// name selects, and rebuilds it. The checks are, in order: strict JSON, the
// exact key set of every level, the value of every field, and last the byte
// comparison with the rebuild (json_not_canonical: key order, whitespace, an
// escape that JSON.stringify would not write).
func ParseCreate(body []byte, r *route.Route, env *Env) (*Create, *deny.Error) {
	root, derr := jsonx.Parse(body)
	if derr != nil {
		return nil, derr
	}
	if root.Kind != jsonx.KindObject {
		return nil, deny.FieldOnly(deny.JSONType, "$")
	}
	var (
		c   *Create
		err *deny.Error
	)
	if r.Suffix == route.SuffixHelper {
		c, err = parseHelper(root, r, env)
	} else {
		c, err = parseBot(root, r, env)
	}
	if err != nil {
		return nil, err
	}
	if string(c.Body) != string(body) {
		return nil, deny.New(deny.JSONNotCanonical)
	}
	return c, nil
}

// --- typed access with reasons ----------------------------------------------

func join(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

// object checks that v is an object whose keys are exactly keys, and returns
// its members by key. A key outside the schema is json_unknown_key, a missing
// one is json_value.
func object(v *jsonx.Value, path string, keys ...string) (map[string]*jsonx.Value, *deny.Error) {
	if v.Kind != jsonx.KindObject {
		return nil, deny.FieldOnly(deny.JSONType, path)
	}
	want := make(map[string]struct{}, len(keys))
	for _, k := range keys {
		want[k] = struct{}{}
	}
	got := make(map[string]*jsonx.Value, len(v.Members))
	for _, m := range v.Members {
		if _, ok := want[m.Key]; !ok {
			return nil, deny.Field(deny.JSONUnknownKey, path, []byte(m.Key))
		}
		got[m.Key] = m.Val
	}
	for _, k := range keys {
		if _, ok := got[k]; !ok {
			return nil, deny.FieldOnly(deny.JSONValue, join(path, k))
		}
	}
	return got, nil
}

func str(v *jsonx.Value, path string) (string, *deny.Error) {
	if v.Kind != jsonx.KindString {
		return "", deny.FieldOnly(deny.JSONType, path)
	}
	return v.S, nil
}

func integer(v *jsonx.Value, path string) (int64, *deny.Error) {
	if v.Kind != jsonx.KindInt {
		return 0, deny.FieldOnly(deny.JSONType, path)
	}
	return v.N, nil
}

func boolean(v *jsonx.Value, path string) (bool, *deny.Error) {
	if v.Kind != jsonx.KindBool {
		return false, deny.FieldOnly(deny.JSONType, path)
	}
	return v.B, nil
}

func strList(v *jsonx.Value, path string) ([]string, *deny.Error) {
	if v.Kind != jsonx.KindArray {
		return nil, deny.FieldOnly(deny.JSONType, path)
	}
	out := make([]string, 0, len(v.Elems))
	for i, e := range v.Elems {
		s, err := str(e, path+"["+strconv.Itoa(i)+"]")
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}

// wantStr requires the string value of a fixed field.
func wantStr(v *jsonx.Value, path, want, code string) *deny.Error {
	s, err := str(v, path)
	if err != nil {
		return err
	}
	if s != want {
		return deny.Field(code, path, []byte(s))
	}
	return nil
}

func wantBool(v *jsonx.Value, path string, want bool) *deny.Error {
	b, err := boolean(v, path)
	if err != nil {
		return err
	}
	if b != want {
		return deny.FieldOnly(deny.JSONValue, path)
	}
	return nil
}

func wantInt(v *jsonx.Value, path string, want int64) *deny.Error {
	n, err := integer(v, path)
	if err != nil {
		return err
	}
	if n != want {
		return deny.FieldOnly(deny.JSONValue, path)
	}
	return nil
}

// wantList requires a string array equal to want. The code is the reason of a
// value that differs.
func wantList(v *jsonx.Value, path string, want []string, code string) *deny.Error {
	got, err := strList(v, path)
	if err != nil {
		return err
	}
	equal := len(got) == len(want)
	for i := 0; equal && i < len(got); i++ {
		equal = got[i] == want[i]
	}
	if !equal {
		joined := ""
		for _, g := range got {
			joined += g + "\x00"
		}
		return deny.Field(code, path, []byte(joined))
	}
	return nil
}

// wantSingle requires an object {key: value} with a string value.
func wantSingle(v *jsonx.Value, path, key, value string) *deny.Error {
	m, err := object(v, path, key)
	if err != nil {
		return err
	}
	return wantStr(m[key], join(path, key), value, deny.JSONValue)
}

// --- bot form ---------------------------------------------------------------

func parseBot(root *jsonx.Value, r *route.Route, env *Env) (*Create, *deny.Error) {
	// A member of a shared scope instance carries one more top-level key, Env,
	// and a second tmpfs; nothing else about the body changes.
	// Only the exact member Env counts; any other Env stays an unknown key.
	shared := false
	for _, m := range root.Members {
		if m.Key == "Env" && m.Val.Kind == jsonx.KindArray && len(m.Val.Elems) == 1 &&
			m.Val.Elems[0].Kind == jsonx.KindString && m.Val.Elems[0].S == ScopeSubdirEnv+"="+r.BotKey {
			shared = true
		}
	}
	keys := []string{"Image", "Labels", "HostConfig"}
	if shared {
		keys = []string{"Image", "Labels", "Env", "HostConfig"}
	}
	top, err := object(root, "", keys...)
	if err != nil {
		return nil, err
	}
	image, err := str(top["Image"], "Image")
	if err != nil {
		return nil, err
	}
	if _, ok := env.Images[image]; !ok {
		return nil, deny.Field(deny.ImageNotAllowed, "Image", []byte(image))
	}

	labels, err := object(top["Labels"], "Labels", "myrmidon.bot", "myrmidon.image")
	if err != nil {
		return nil, err
	}
	if err := wantStr(labels["myrmidon.bot"], "Labels.myrmidon.bot", r.BotKey, deny.NameLabelMismatch); err != nil {
		return nil, err
	}
	if err := wantStr(labels["myrmidon.image"], "Labels.myrmidon.image", image, deny.JSONValue); err != nil {
		return nil, err
	}

	hc, err := object(top["HostConfig"], "HostConfig",
		"Memory", "NanoCpus", "PidsLimit", "CapDrop", "SecurityOpt", "ReadonlyRootfs", "Tmpfs",
		"Init", "RestartPolicy", "NetworkMode", "Binds", "Privileged")
	if err != nil {
		return nil, err
	}
	memory, err := ceiling(hc["Memory"], "HostConfig.Memory", env.MaxMemoryMB*1048576)
	if err != nil {
		return nil, err
	}
	nano, err := ceiling(hc["NanoCpus"], "HostConfig.NanoCpus", int64(math.Round(env.MaxCPUs*1e9)))
	if err != nil {
		return nil, err
	}
	pids, err := ceiling(hc["PidsLimit"], "HostConfig.PidsLimit", env.MaxPids)
	if err != nil {
		return nil, err
	}
	if err := commonHostConfig(hc, "on-failure"); err != nil {
		return nil, err
	}
	var tmpfs map[string]*jsonx.Value
	if shared {
		tmpfs, err = object(hc["Tmpfs"], "HostConfig.Tmpfs", "/tmp", "/data")
	} else {
		tmpfs, err = object(hc["Tmpfs"], "HostConfig.Tmpfs", "/tmp")
	}
	if err != nil {
		return nil, err
	}
	if err := wantStr(tmpfs["/tmp"], "HostConfig.Tmpfs./tmp", "", deny.JSONValue); err != nil {
		return nil, err
	}
	if shared {
		if err := wantStr(tmpfs["/data"], "HostConfig.Tmpfs./data", ScopeDataTmpfs, deny.JSONValue); err != nil {
			return nil, err
		}
	}
	if err := wantBool(hc["Init"], "HostConfig.Init", true); err != nil {
		return nil, err
	}
	if err := wantStr(hc["NetworkMode"], "HostConfig.NetworkMode", env.Network, deny.NetworkMismatch); err != nil {
		return nil, err
	}
	binds, instance, err := parseBotBinds(hc["Binds"], "HostConfig.Binds", env, r.BotKey, shared)
	if err != nil {
		return nil, err
	}

	w := &writer{}
	w.raw(`{"Image":`).str(image)
	w.raw(`,"Labels":{"myrmidon.bot":`).str(r.BotKey).raw(`,"myrmidon.image":`).str(image).raw(`}`)
	if shared {
		w.raw(`,"Env":[`).str(ScopeSubdirEnv + "=" + r.BotKey).raw(`]`)
	}
	w.raw(`,"HostConfig":{"Memory":`).int(memory).raw(`,"NanoCpus":`).int(nano).raw(`,"PidsLimit":`).int(pids)
	w.raw(`,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],"ReadonlyRootfs":true`)
	if shared {
		w.raw(`,"Tmpfs":{"/tmp":"","/data":`).str(ScopeDataTmpfs).raw(`},"Init":true,"RestartPolicy":{"Name":"on-failure"}`)
	} else {
		w.raw(`,"Tmpfs":{"/tmp":""},"Init":true,"RestartPolicy":{"Name":"on-failure"}`)
	}
	w.raw(`,"NetworkMode":`).str(env.Network).raw(`,"Binds":`).strs(binds).raw(`,"Privileged":false}}`)
	return &Create{Form: FormBot, BotKey: r.BotKey, Image: image, ScopeInstance: instance, Body: w.b}, nil
}

// ceiling reads a resource limit: 0 < value <= max. A limit above the
// enrolled ceiling is limit_exceeds_enrollment; a non-positive one is
// json_value.
func ceiling(v *jsonx.Value, path string, max int64) (int64, *deny.Error) {
	n, err := integer(v, path)
	if err != nil {
		return 0, err
	}
	if n <= 0 {
		return 0, deny.FieldOnly(deny.JSONValue, path)
	}
	if n > max {
		return 0, deny.FieldOnly(deny.LimitExceedsEnrolled, path)
	}
	return n, nil
}

// commonHostConfig checks the fields that the bot and the helper have in
// common: CapDrop, SecurityOpt, ReadonlyRootfs, RestartPolicy, Privileged.
// The reason of a wrong value is json_value; the fields with a reason of their
// own (Memory, NetworkMode, Binds) are checked by the callers.
func commonHostConfig(hc map[string]*jsonx.Value, restart string) *deny.Error {
	if err := wantList(hc["CapDrop"], "HostConfig.CapDrop", []string{"ALL"}, deny.JSONValue); err != nil {
		return err
	}
	if err := wantList(hc["SecurityOpt"], "HostConfig.SecurityOpt", []string{"no-new-privileges"}, deny.JSONValue); err != nil {
		return err
	}
	if err := wantBool(hc["ReadonlyRootfs"], "HostConfig.ReadonlyRootfs", true); err != nil {
		return err
	}
	if err := wantSingle(hc["RestartPolicy"], "HostConfig.RestartPolicy", "Name", restart); err != nil {
		return err
	}
	return wantBool(hc["Privileged"], "HostConfig.Privileged", false)
}

// --- helper forms -----------------------------------------------------------

const (
	helperMemory = 134217728
	helperPids   = 64
)

func parseHelper(root *jsonx.Value, r *route.Route, env *Env) (*Create, *deny.Error) {
	top, err := object(root, "", "Image", "User", "Entrypoint", "Cmd", "Labels", "NetworkDisabled", "HostConfig")
	if err != nil {
		return nil, err
	}
	user, err := str(top["User"], "User")
	if err != nil {
		return nil, err
	}
	var form Form
	switch user {
	case "0:0":
		form = FormHelperPrepare
	case "10001:10001":
		form = FormHelperApply
	default:
		return nil, deny.Field(deny.JSONValue, "User", []byte(user))
	}

	image, err := str(top["Image"], "Image")
	if err != nil {
		return nil, err
	}
	if form == FormHelperPrepare {
		if _, ok := env.Images[image]; !ok {
			return nil, deny.Field(deny.ImageNotAllowed, "Image", []byte(image))
		}
	} else if !IsImageID(image) {
		return nil, deny.Field(deny.ImageNotAllowed, "Image", []byte(image))
	}

	if err := wantList(top["Entrypoint"], "Entrypoint", []string{"/bin/sh", "-c"}, deny.JSONValue); err != nil {
		return nil, err
	}
	cmd, err := strList(top["Cmd"], "Cmd")
	if err != nil {
		return nil, err
	}
	if len(cmd) != 3 {
		return nil, deny.FieldOnly(deny.JSONValue, "Cmd")
	}
	if cmd[1] != "myrmidon-helper" || cmd[2] != "/" {
		return nil, deny.FieldOnly(deny.JSONValue, "Cmd")
	}
	var nonce string
	// The prepare helper of a shared member runs its own constant script (it also
	// hands the instance directory to the bot's uid); which of the two applies is
	// settled by the binds below, and the pairing is checked there.
	sharedPrepare := false
	if form == FormHelperPrepare {
		switch cmd[0] {
		case PrepareScript:
		case PrepareScriptShared:
			sharedPrepare = true
		default:
			return nil, deny.Field(deny.ScriptMismatch, "Cmd[0]", []byte(cmd[0])).WithDetail("prepare")
		}
	} else {
		n, derr := ExtractNonce(cmd[0])
		if derr != nil {
			return nil, derr.At("Cmd[0]", []byte(cmd[0]))
		}
		nonce = n
	}

	labels, err := object(top["Labels"], "Labels", "myrmidon.bot-helper")
	if err != nil {
		return nil, err
	}
	if err := wantStr(labels["myrmidon.bot-helper"], "Labels.myrmidon.bot-helper", r.BotKey, deny.NameLabelMismatch); err != nil {
		return nil, err
	}
	if err := wantBool(top["NetworkDisabled"], "NetworkDisabled", true); err != nil {
		return nil, err
	}

	hc, err := object(top["HostConfig"], "HostConfig",
		"Memory", "PidsLimit", "CapDrop", "CapAdd", "SecurityOpt", "ReadonlyRootfs",
		"RestartPolicy", "NetworkMode", "Binds", "Privileged")
	if err != nil {
		return nil, err
	}
	if err := wantInt(hc["Memory"], "HostConfig.Memory", helperMemory); err != nil {
		return nil, err
	}
	if err := wantInt(hc["PidsLimit"], "HostConfig.PidsLimit", helperPids); err != nil {
		return nil, err
	}
	capAdd := []string{"CHOWN", "FOWNER"}
	if form == FormHelperApply {
		capAdd = []string{}
	}
	if err := wantList(hc["CapAdd"], "HostConfig.CapAdd", capAdd, deny.JSONValue); err != nil {
		return nil, err
	}
	if err := commonHostConfig(hc, "no"); err != nil {
		return nil, err
	}
	if err := wantStr(hc["NetworkMode"], "HostConfig.NetworkMode", "none", deny.JSONValue); err != nil {
		return nil, err
	}
	gotBinds, err := strList(hc["Binds"], "HostConfig.Binds")
	if err != nil {
		return nil, err
	}
	binds, instance, derr := matchHelperBinds(gotBinds, env, r.BotKey, form == FormHelperPrepare, sharedPrepare)
	if derr != nil {
		return nil, derr
	}

	w := &writer{}
	w.raw(`{"Image":`).str(image).raw(`,"User":`).str(user)
	w.raw(`,"Entrypoint":["/bin/sh","-c"],"Cmd":[`).str(cmd[0]).raw(`,"myrmidon-helper","/"]`)
	w.raw(`,"Labels":{"myrmidon.bot-helper":`).str(r.BotKey).raw(`},"NetworkDisabled":true`)
	w.raw(`,"HostConfig":{"Memory":134217728,"PidsLimit":64,"CapDrop":["ALL"],"CapAdd":`).strs(capAdd)
	w.raw(`,"SecurityOpt":["no-new-privileges"],"ReadonlyRootfs":true,"RestartPolicy":{"Name":"no"}`)
	w.raw(`,"NetworkMode":"none","Binds":`).strs(binds).raw(`,"Privileged":false}}`)
	return &Create{Form: form, BotKey: r.BotKey, Image: image, Nonce: nonce, ScopeInstance: instance, Body: w.b}, nil
}

// matchHelperBinds checks the binds of a helper: the bot's isolated directories,
// or the same three inside the member's subdirectory of ONE scope instance the
// bot is enrolled for (the prepare helper then also binds the instance
// directory). The prepare script must be the one of the layout. The second
// result is the instance ("" for isolated).
func matchHelperBinds(got []string, env *Env, botKey string, prepare, sharedPrepare bool) ([]string, string, *deny.Error) {
	equal := func(want []string) bool {
		if len(got) != len(want) {
			return false
		}
		for i := range want {
			if got[i] != want[i] {
				return false
			}
		}
		return true
	}
	if !sharedPrepare {
		if want := Binds(env.VolumeRoot, botKey); equal(want) {
			return want, "", nil
		}
	}
	// A shared layout: the instance is read from the first bind.
	if env.ScopeRoot != "" && len(got) > 0 {
		prefix := env.ScopeRoot + "/"
		suffix := "/" + botKey + "/hermes:/data/hermes"
		if strings.HasPrefix(got[0], prefix) && strings.HasSuffix(got[0], suffix) {
			instance := strings.TrimSuffix(strings.TrimPrefix(got[0], prefix), suffix)
			if env.scopeEnrolled(instance) {
				want := ScopeHelperBinds(env.ScopeRoot, instance, botKey, prepare)
				if equal(want) {
					if prepare && !sharedPrepare {
						return nil, "", deny.Field(deny.ScriptMismatch, "Cmd[0]", []byte("prepare")).WithDetail("prepare_scope")
					}
					return want, instance, nil
				}
			}
			return nil, "", deny.Field(deny.MountSourceNotAllowed, "HostConfig.Binds", []byte(got[0]))
		}
	}
	return nil, "", deny.Field(deny.BindsMismatch, "HostConfig.Binds", []byte(strings.Join(got, "\x00")))
}

// The limits-override file (OPE-12383): the mutable part of dockergate's
// configuration — the per-bot resource limits the board applies through the
// A20 route — in a file the gate can write when the main config file is
// mounted read-only into the container. The override carries ONLY bot limit
// entries (the applied limits and the ratcheted ceilings of update.go);
// everything else (images, caller, the global shape) stays operator-owned in
// the main file. A missing override file is no override at all; a corrupt or
// unverifiable one refuses the start (the gate never runs on a config it
// cannot verify).
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

// OverrideBot is one bot's entry in the limits-override file: exactly what an
// A20 update persists for the bot — the applied limits and the ceilings that
// ApplyBotUpdate has ratcheted (a ceiling stays where the first update pinned
// it, so later updates cannot push past the enrolment). The ceilings still
// bound every value (Validate rejects limits above the ceiling), so the
// override can never raise a ceiling.
type OverrideBot struct {
	BotKey          string  `json:"botKey"`
	MemoryMB        int64   `json:"memoryMb"`
	CPUs            float64 `json:"cpus"`
	PidsLimit       int64   `json:"pidsLimit"`
	CeilingMemoryMB int64   `json:"ceilingMemoryMb,omitempty"`
	CeilingCPUs     float64 `json:"ceilingCpus,omitempty"`
	CeilingPids     int64   `json:"ceilingPids,omitempty"`
}

// DecodeLimitsOverride accepts exactly the documented shape: an object with
// "bots", every entry the four applied fields (plus the optional ceilings),
// no duplicates.
func DecodeLimitsOverride(data []byte) ([]OverrideBot, error) {
	var wrapper struct {
		Bots []OverrideBot `json:"bots"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&wrapper); err != nil {
		return nil, fmt.Errorf("config: limits override: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("config: limits override: data after the object")
	}
	seen := map[string]bool{}
	for _, b := range wrapper.Bots {
		if !botKeyRe.MatchString(b.BotKey) {
			return nil, errors.New("config: limits override: bots[].botKey must be a lowercase uuid")
		}
		if seen[b.BotKey] {
			return nil, errors.New("config: limits override: duplicate botKey in bots")
		}
		seen[b.BotKey] = true
	}
	return wrapper.Bots, nil
}

// LoadLimitsOverride reads and checks the limits-override file. A missing
// file is no override (nil, nil); anything unreadable or invalid is an error.
func LoadLimitsOverride(path string) ([]OverrideBot, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("config: limits override: %w", err)
	}
	return DecodeLimitsOverride(data)
}

// ApplyLimitsOverride replaces the per-bot limits of cfg with the entries of
// the override. A bot that is not enrolled in the main file is refused: the
// enrolment stays operator-owned. On refusal cfg is unchanged.
func ApplyLimitsOverride(cfg *Config, bots []OverrideBot) error {
	if len(bots) == 0 {
		return nil
	}
	index := make(map[string]int, len(cfg.Bots))
	for i := range cfg.Bots {
		index[cfg.Bots[i].BotKey] = i
	}
	next := cfg.Clone()
	for _, ob := range bots {
		i, ok := index[ob.BotKey]
		if !ok {
			return fmt.Errorf("config: limits override: bot %q is not enrolled", ob.BotKey)
		}
		next.Bots[i].MaxMemoryMB = ob.MemoryMB
		next.Bots[i].MaxCPUs = ob.CPUs
		next.Bots[i].MaxPids = ob.PidsLimit
		if ob.CeilingMemoryMB > 0 {
			next.Bots[i].CeilingMemoryMB = ob.CeilingMemoryMB
		}
		if ob.CeilingCPUs > 0 {
			next.Bots[i].CeilingCPUs = ob.CeilingCPUs
		}
		if ob.CeilingPids > 0 {
			next.Bots[i].CeilingPids = ob.CeilingPids
		}
	}
	if err := next.Validate(); err != nil {
		return fmt.Errorf("config: limits override: merged config is invalid: %w", err)
	}
	*cfg = *next
	return nil
}

// WriteLimitsOverride atomically writes the override file: one rename, with
// the file and its directory synced first, like WriteAtomic. Mode 0600: the
// file carries nothing secret, but only the gate's uid needs it.
func WriteLimitsOverride(path string, bots []OverrideBot) error {
	if path == "" {
		return errors.New("config: limits override: path is required")
	}
	data, err := json.MarshalIndent(struct {
		Bots []OverrideBot `json:"bots"`
	}{bots}, "", "  ")
	if err != nil {
		return fmt.Errorf("config: limits override: marshal: %w", err)
	}
	data = append(data, '\n')
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".dockergate-limits-override-*")
	if err != nil {
		return fmt.Errorf("config: limits override: create temp: %w", readOnlyIf(err))
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return fmt.Errorf("config: limits override: chmod: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return fmt.Errorf("config: limits override: write: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("config: limits override: sync: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("config: limits override: close: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("config: limits override: rename: %w", readOnlyIf(err))
	}
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("config: limits override: open directory: %w", err)
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("config: limits override: sync directory: %w", err)
	}
	return nil
}

// readOnlyIf marks the filesystem-level refusals of the override write (a
// read-only mount, a missing directory, a permission of the uid) so the
// caller can tell them apart from a refusal about the values: those are
// config_read_only, never upstream_error (OPE-12383).
func readOnlyIf(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, os.ErrPermission) || errors.Is(err, syscall.EROFS) || errors.Is(err, os.ErrNotExist) {
		return &ReadOnlyError{Err: err}
	}
	return err
}

// ReadOnlyError reports a write that the filesystem refused (a read-only
// mount, a missing directory, a permission of the uid).
type ReadOnlyError struct{ Err error }

func (e *ReadOnlyError) Error() string { return e.Err.Error() }
func (e *ReadOnlyError) Unwrap() error { return e.Err }

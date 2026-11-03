package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// BotUpdate is the resource configuration received from the board for one bot.
// The dockergate socket already authenticates the caller with SO_PEERCRED; this
// type deliberately contains no second token or credential.
type BotUpdate struct {
	BotKey    string  `json:"botKey"`
	MemoryMB  int64   `json:"memoryMb"`
	CPUs      float64 `json:"cpus"`
	PidsLimit int64   `json:"pidsLimit"`
}

// ValidateBotUpdate checks the requested limits against the platform ceilings.
func ValidateBotUpdate(c *Config, u BotUpdate) error {
	if u.BotKey == "" {
		return errors.New("botKey is required")
	}
	if !botKeyRe.MatchString(u.BotKey) {
		return errors.New("botKey must be a lowercase uuid")
	}
	maxMem, maxCPUs, maxPids, ok := c.CeilingsFor(u.BotKey)
	if !ok {
		return fmt.Errorf("bot %q is not enrolled", u.BotKey)
	}
	if u.MemoryMB <= 0 {
		return errors.New("memoryMb must be greater than zero")
	}
	if maxMem > 0 && u.MemoryMB > maxMem {
		return fmt.Errorf("memoryMb %d exceeds platform ceiling %d", u.MemoryMB, maxMem)
	}
	if !(u.CPUs > 0) {
		return errors.New("cpus must be greater than zero")
	}
	if maxCPUs > 0 && u.CPUs > maxCPUs {
		return fmt.Errorf("cpus %g exceeds platform ceiling %g", u.CPUs, maxCPUs)
	}
	if u.PidsLimit <= 0 {
		return errors.New("pidsLimit must be greater than zero")
	}
	if maxPids > 0 && u.PidsLimit > maxPids {
		return fmt.Errorf("pidsLimit %d exceeds platform ceiling %d", u.PidsLimit, maxPids)
	}
	return nil
}

// ApplyBotUpdate validates and structurally replaces the selected bots[] entry.
// Ceilings are preserved: if a ceiling was not previously set explicitly, the
// current max limits become the ceiling so subsequent updates cannot exceed it.
func ApplyBotUpdate(c *Config, u BotUpdate) error {
	if err := ValidateBotUpdate(c, u); err != nil {
		return err
	}
	maxMem, maxCPUs, maxPids, _ := c.CeilingsFor(u.BotKey)
	for i := range c.Bots {
		if c.Bots[i].BotKey == u.BotKey {
			if c.Bots[i].CeilingMemoryMB <= 0 {
				c.Bots[i].CeilingMemoryMB = maxMem
			}
			if c.Bots[i].CeilingCPUs <= 0 {
				c.Bots[i].CeilingCPUs = maxCPUs
			}
			if c.Bots[i].CeilingPids <= 0 {
				c.Bots[i].CeilingPids = maxPids
			}
			c.Bots[i].MaxMemoryMB = u.MemoryMB
			c.Bots[i].MaxCPUs = u.CPUs
			c.Bots[i].MaxPids = u.PidsLimit
			return nil
		}
	}
	return fmt.Errorf("bot %q is not enrolled", u.BotKey)
}

// WriteAtomic writes a complete validated config and makes it visible with one
// rename. No process restart is involved; the caller invokes Gate.Reload after
// this returns successfully.
func WriteAtomic(path string, c *Config) error {
	if err := c.Validate(); err != nil {
		return fmt.Errorf("config update: %w", err)
	}
	if path == "" {
		return errors.New("config update: path is required")
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("config update: marshal: %w", err)
	}
	data = append(data, '\n')
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".dockergate-config-*")
	if err != nil {
		return fmt.Errorf("config update: create temp: %w", err)
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return fmt.Errorf("config update: chmod: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return fmt.Errorf("config update: write: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("config update: sync: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("config update: close: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("config update: rename: %w", err)
	}
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("config update: open directory: %w", err)
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("config update: sync directory: %w", err)
	}
	return nil
}

// DecodeBotUpdate accepts exactly the four documented JSON fields.
func DecodeBotUpdate(data []byte) (BotUpdate, error) {
	var u BotUpdate
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&u); err != nil {
		return BotUpdate{}, fmt.Errorf("invalid config update: %w", err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return BotUpdate{}, errors.New("invalid config update: trailing data")
	}
	if u.BotKey != "" && !botKeyRe.MatchString(u.BotKey) {
		return BotUpdate{}, errors.New("invalid config update: botKey must be a lowercase uuid")
	}
	return u, nil
}

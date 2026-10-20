package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	defaultMemoryTimeout = 15 * time.Second
	maxMemoryResponse    = 2 << 20
)

// memoryConfig is optional. The zero value keeps centralized memory disabled.
// The client uses only an HTTP endpoint; it never reads a host path or socket.
type memoryConfig struct {
	Enabled   bool   `json:"enabled"`
	URL       string `json:"url"`
	Token     string `json:"token,omitempty"`
	Bank      string `json:"bank"`
	TimeoutMs int    `json:"timeoutMs,omitempty"`
}

type memoryClient struct {
	baseURL string
	token   string
	bank    string
	timeout time.Duration
	client  *http.Client
}

func newMemoryClient(cfg *memoryConfig) (*memoryClient, error) {
	if cfg == nil || !cfg.Enabled {
		return nil, fmt.Errorf("centralized_memory_disabled")
	}
	base, err := validateMemoryURL(cfg.URL)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(cfg.Bank) == "" {
		return nil, fmt.Errorf("memory.bank is required")
	}
	timeout := defaultMemoryTimeout
	if cfg.TimeoutMs != 0 {
		if cfg.TimeoutMs < 100 || cfg.TimeoutMs > 120000 {
			return nil, fmt.Errorf("memory.timeoutMs must be between 100 and 120000")
		}
		timeout = time.Duration(cfg.TimeoutMs) * time.Millisecond
	}
	return &memoryClient{
		baseURL: strings.TrimRight(base, "/"),
		token:   cfg.Token,
		bank:    cfg.Bank,
		timeout: timeout,
		client:  &http.Client{Timeout: timeout},
	}, nil
}

func validateMemoryURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", fmt.Errorf("memory.url must be an http(s) URL")
	}
	if u.User != nil {
		return "", fmt.Errorf("memory.url must not contain credentials")
	}
	return raw, nil
}

func (c *memoryClient) endpoint(suffix string) string {
	return c.baseURL + "/v1/default/banks/" + url.PathEscape(c.bank) + "/memories" + suffix
}

func (c *memoryClient) request(ctx context.Context, method, suffix string, body any) ([]byte, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("memory request encode: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint(suffix), bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("memory request create: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("memory upstream unavailable: %w", err)
	}
	defer resp.Body.Close()
	data, readErr := io.ReadAll(io.LimitReader(resp.Body, maxMemoryResponse+1))
	if readErr != nil {
		return nil, fmt.Errorf("memory upstream read: %w", readErr)
	}
	if len(data) > maxMemoryResponse {
		return nil, fmt.Errorf("memory upstream response too large")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("memory upstream returned HTTP %d", resp.StatusCode)
	}
	return data, nil
}

func (c *memoryClient) recall(ctx context.Context, query, budget string, maxTokens int) ([]byte, error) {
	if strings.TrimSpace(query) == "" {
		return nil, fmt.Errorf("memory query is required")
	}
	if budget == "" {
		budget = "mid"
	}
	if maxTokens <= 0 {
		maxTokens = 1024
	}
	return c.request(ctx, http.MethodPost, "/recall", map[string]any{
		"query": query, "budget": budget, "max_tokens": maxTokens,
	})
}

func (c *memoryClient) retain(ctx context.Context, content, contextName, documentID string, metadata map[string]any) ([]byte, error) {
	if strings.TrimSpace(content) == "" {
		return nil, fmt.Errorf("memory content is required")
	}
	if contextName == "" {
		contextName = "fleetd"
	}
	item := map[string]any{"content": content, "context": contextName}
	if documentID != "" {
		item["document_id"] = documentID
	}
	if metadata != nil {
		item["metadata"] = metadata
	}
	return c.request(ctx, http.MethodPost, "", map[string]any{
		"items": []any{item}, "async": true,
	})
}

type memoryRecallRequest struct {
	Query     string `json:"query"`
	Budget    string `json:"budget,omitempty"`
	MaxTokens int    `json:"max_tokens,omitempty"`
}

type memoryRetainRequest struct {
	Content    string         `json:"content"`
	Context    string         `json:"context,omitempty"`
	DocumentID string         `json:"document_id,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

func decodeMemoryBody(r *http.Request, out any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, maxMemoryResponse))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return fmt.Errorf("invalid memory request")
	}
	return nil
}

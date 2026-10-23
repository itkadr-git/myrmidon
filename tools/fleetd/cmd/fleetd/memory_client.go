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
	maxMemoryExport      = 64 << 20
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

type memoryExportRequest struct {
	BotKey string `json:"botKey"`
}

func validMemoryBotKey(key string) bool {
	return validBotKey(key)
}

func (c *memoryClient) export(ctx context.Context, bankID string) ([]byte, error) {
	if strings.TrimSpace(bankID) == "" {
		return nil, fmt.Errorf("memory bank id is required")
	}
	bankPath := "/v1/default/banks/" + url.PathEscape(bankID)
	startURL := c.baseURL + bankPath + "/transfer/export?include_data=true&include_bank_config=true&include_history=false"
	startReq, err := http.NewRequestWithContext(ctx, http.MethodPost, startURL, nil)
	if err != nil {
		return nil, fmt.Errorf("memory export request create: %w", err)
	}
	startReq.Header.Set("Accept", "application/json")
	if c.token != "" {
		startReq.Header.Set("Authorization", "Bearer "+c.token)
	}
	startData, err := c.doMemoryRequest(startReq, maxMemoryResponse)
	if err != nil {
		return nil, fmt.Errorf("memory export start: %w", err)
	}
	var operation struct {
		OperationID string `json:"operation_id"`
	}
	if err := json.Unmarshal(startData, &operation); err != nil || strings.TrimSpace(operation.OperationID) == "" {
		return nil, fmt.Errorf("memory export start returned invalid operation")
	}

	operationURL := c.baseURL + bankPath + "/operations/" + url.PathEscape(operation.OperationID)
	deadline := time.NewTimer(c.timeout)
	defer deadline.Stop()
	poll := time.NewTicker(250 * time.Millisecond)
	defer poll.Stop()
	for {
		statusReq, err := http.NewRequestWithContext(ctx, http.MethodGet, operationURL, nil)
		if err != nil {
			return nil, fmt.Errorf("memory export status request create: %w", err)
		}
		statusReq.Header.Set("Accept", "application/json")
		if c.token != "" {
			statusReq.Header.Set("Authorization", "Bearer "+c.token)
		}
		statusData, err := c.doMemoryRequest(statusReq, maxMemoryResponse)
		if err != nil {
			return nil, fmt.Errorf("memory export status: %w", err)
		}
		var status struct {
			Status         string `json:"status"`
			ResultMetadata struct {
				DownloadURL string `json:"download_url"`
			} `json:"result_metadata"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal(statusData, &status); err != nil {
			return nil, fmt.Errorf("memory export status returned invalid response")
		}
		switch status.Status {
		case "completed":
			downloadURL, err := c.validateExportDownloadURL(status.ResultMetadata.DownloadURL)
			if err != nil {
				return nil, err
			}
			downloadReq, err := http.NewRequestWithContext(ctx, http.MethodGet, downloadURL, nil)
			if err != nil {
				return nil, fmt.Errorf("memory export download request create: %w", err)
			}
			if c.token != "" {
				downloadReq.Header.Set("Authorization", "Bearer "+c.token)
			}
			return c.doMemoryRequest(downloadReq, maxMemoryExport)
		case "failed", "cancelled":
			return nil, fmt.Errorf("memory export operation %s: %s", status.Status, status.Error)
		case "pending", "processing", "running", "":
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-deadline.C:
				return nil, fmt.Errorf("memory export operation timed out")
			case <-poll.C:
			}
		default:
			return nil, fmt.Errorf("memory export operation has unknown status %q", status.Status)
		}
	}
}

func (c *memoryClient) validateExportDownloadURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	base, _ := url.Parse(c.baseURL)
	if err != nil || parsed == nil || base == nil || parsed.Scheme != base.Scheme || parsed.Host != base.Host || parsed.User != nil {
		return "", fmt.Errorf("memory export returned an unsafe download URL")
	}
	return raw, nil
}

func (c *memoryClient) doMemoryRequest(req *http.Request, limit int64) ([]byte, error) {
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("upstream unavailable: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("upstream read: %w", err)
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("upstream response too large")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("upstream returned HTTP %d", resp.StatusCode)
	}
	return data, nil
}

func decodeMemoryBody(r *http.Request, out any) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, maxMemoryResponse))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return fmt.Errorf("invalid memory request")
	}
	return nil
}

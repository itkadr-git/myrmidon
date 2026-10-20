package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type dockerClient struct {
	socket     string
	api        string
	volumeRoot string
	network    string
	images     []string
}

const dockerAPIVersion = "v1.41"

func newDockerClient(c *config) *dockerClient {
	api := strings.TrimPrefix(c.DockerAPIVersion, "v")
	if api == "" {
		api = strings.TrimPrefix(dockerAPIVersion, "v")
	}
	return &dockerClient{socket: c.Upstream, api: api, volumeRoot: c.VolumeRoot, network: c.Network, images: c.Images}
}
func (d *dockerClient) prefix() string { return "v" + d.api }
func (d *dockerClient) request(ctx context.Context, method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://docker"+path, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return net.DialTimeout("unix", d.socket, 5*time.Second)
	}}
	resp, err := (&http.Client{Transport: tr, Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("docker %s: %s", resp.Status, string(b))
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}
func (d *dockerClient) name(bot string) string { return "fleet-" + bot }
func (d *dockerClient) allowedImage(image string) bool {
	if len(d.images) == 0 {
		return false
	}
	for _, v := range d.images {
		if v == image {
			return true
		}
	}
	return false
}
func (d *dockerClient) create(ctx context.Context, sp spec) error {
	if !d.allowedImage(sp.Image) {
		return fmt.Errorf("image_not_allowed")
	}
	if sp.Network != "" && d.network != "" && sp.Network != d.network {
		return fmt.Errorf("network_not_allowed")
	}
	labels := sp.Labels
	if labels == nil {
		labels = map[string]string{}
	}
	labels["paperclip.botKey"] = sp.BotKey
	host := map[string]any{"Memory": sp.MemoryMb * 1024 * 1024, "NanoCpus": int64(sp.Cpus * 1e9), "PidsLimit": sp.PidsLimit}
	host["ReadonlyRootfs"] = true
	host["CapDrop"] = []string{"ALL"}
	host["SecurityOpt"] = []string{"no-new-privileges:true"}
	host["ShmSize"] = int64(64 * 1024 * 1024)
	if d.network != "" {
		host["NetworkMode"] = d.network
	}
	if sp.GatewayPort > 0 {
		host["PortBindings"] = map[string][]map[string]string{"8642/tcp": {{"HostPort": fmt.Sprint(sp.GatewayPort)}}}
	}
	if sp.BoardExtraHost != "" {
		host["ExtraHosts"] = []string{sp.BoardExtraHost}
	}
	binds := make([]string, 0, len(sp.Mounts))
	for _, mount := range sp.Mounts {
		mode := "rw"
		if mount.ReadOnly {
			mode = "ro"
		}
		binds = append(binds, mount.Source+":"+mount.Destination+":"+mode)
	}
	if len(binds) > 0 {
		host["Binds"] = binds
	}
	body := map[string]any{"Image": sp.Image, "User": "10001", "Labels": labels, "HostConfig": host}
	var out any
	return d.request(ctx, http.MethodPost, "/"+d.prefix()+"/containers/create?name="+url.QueryEscape(d.name(sp.BotKey)), body, &out)
}
func (d *dockerClient) action(ctx context.Context, bot, action string) error {
	if action == "restart" {
		if err := d.action(ctx, bot, "stop"); err != nil {
			return err
		}
		action = "start"
	}
	return d.request(ctx, http.MethodPost, "/"+d.prefix()+"/containers/"+url.PathEscape(d.name(bot))+"/"+action, nil, nil)
}
func (d *dockerClient) remove(ctx context.Context, bot string) error {
	return d.request(ctx, http.MethodDelete, "/"+d.prefix()+"/containers/"+url.PathEscape(d.name(bot))+"?force=true", nil, nil)
}
func (d *dockerClient) status(ctx context.Context, bot string) (botStatus, error) {
	var x struct {
		State struct {
			Status string `json:"Status"`
		} `json:"State"`
		Config struct {
			Image string `json:"Image"`
		} `json:"Config"`
		StateName string `json:"State"`
	}
	err := d.request(ctx, http.MethodGet, "/"+d.prefix()+"/containers/"+url.PathEscape(d.name(bot))+"/json", nil, &x)
	if err != nil {
		if strings.Contains(err.Error(), "404") {
			return botStatus{BotKey: bot, State: "missing"}, nil
		}
		return botStatus{}, err
	}
	state := x.State.Status
	if state == "" {
		state = x.StateName
	}
	return botStatus{BotKey: bot, State: state, Image: x.Config.Image}, nil
}
func (d *dockerClient) logs(ctx context.Context, bot string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/"+d.prefix()+"/containers/"+url.PathEscape(d.name(bot))+"/logs?stdout=true&stderr=true&tail=200", nil)
	if err != nil {
		return "", err
	}
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return net.DialTimeout("unix", d.socket, 5*time.Second)
	}}
	resp, err := (&http.Client{Transport: tr, Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("docker %s", resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	return string(redactLogs(b)), nil
}
func safeProfilePath(root, bot, p string) (string, error) {
	if root == "" {
		return "", fmt.Errorf("profile_root_not_configured")
	}
	clean := filepath.Clean(p)
	if clean == "." || filepath.IsAbs(clean) || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("invalid_profile_path")
	}
	base := filepath.Join(root, bot)
	dest := filepath.Join(base, clean)
	if dest != base && !strings.HasPrefix(dest, base+string(os.PathSeparator)) {
		return "", fmt.Errorf("invalid_profile_path")
	}
	return dest, nil
}

// tools/fleetd is the fleet service for a second machine (FLEETD-VMEXEC):
// it exposes the board's BotContainerDriver contract over HTTP for bot
// containers that live on its own host, enforcing the same fixed template
// the local driver enforces. Code layout mirrors tools/dockergate (Go,
// standard library only; see docs/myrmidon/fleetd-vmexec.md).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"crypto/tls"
	"crypto/x509"
	"strings"
	"syscall"
)

// botStatus is the driver contract's BotContainerStatus.
type botStatus struct {
	BotKey      string  `json:"botKey"`
	State       string  `json:"state"`
	Image       string  `json:"image,omitempty"`
	RestartHash *string `json:"restartHash"`
	FilesHash   *string `json:"filesHash"`
	GatewayPort *int    `json:"gatewayPort,omitempty"`
}

// spec is the driver contract's BotContainerSpec.
type spec struct {
	BotKey    string            `json:"botKey"`
	Image     string            `json:"image"`
	MemoryMb  int64             `json:"memoryMb"`
	Cpus      float64           `json:"cpus"`
	PidsLimit int64             `json:"pidsLimit"`
	Network   string            `json:"network"`
	Labels    map[string]string `json:"labels,omitempty"`
	ExtraMounts []extraMount `json:"extraMounts,omitempty"`
	SharedMount *sharedMount `json:"sharedMount,omitempty"`
}

type extraMount struct { Source string `json:"source"`; ContainerPath string `json:"containerPath"`; ReadOnly bool `json:"readOnly"` }
type sharedMount struct { HostPath string `json:"hostPath,omitempty"`; Writable bool `json:"writable"` }

// profileFile is one file of the compiled profile.
type profileFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mode    int    `json:"mode"`
	Secret  bool   `json:"secret"`
}

// profile is the driver contract's CompiledProfile.
type profile struct {
	BotKey      string        `json:"botKey"`
	Files       []profileFile `json:"files"`
	RestartHash string        `json:"restartHash"`
	FilesHash   string        `json:"filesHash"`
}

// config is the JSON configuration (see docs/myrmidon/fleetd-vmexec.md).
// Unknown keys are rejected at load time, the same discipline as dockergate.
type config struct {
	Listen   string `json:"listen"`
	Token    string `json:"token"`
	Upstream string `json:"upstream"`
	Bots     []bot  `json:"bots"`
	VolumeRoot string `json:"volumeRoot"`
	Network string `json:"network"`
	BoardAddress string `json:"boardAddress"`
	BoardExtraHost string `json:"boardExtraHost"`
	ImageAllowlist []string `json:"imageAllowlist"`
	MountSources []string `json:"mountSources"`
	GatewayPortStart int `json:"gatewayPortStart"`
	GatewayPortEnd int `json:"gatewayPortEnd"`
	TLSCert string `json:"tlsCert"`
	TLSKey string `json:"tlsKey"`
	TLSClientCA string `json:"tlsClientCA"`
	EgressIP string `json:"egressIp"`
}

type bot struct {
	BotKey      string  `json:"botKey"`
	MaxMemoryMb int64   `json:"maxMemoryMb"`
	MaxCpus     float64 `json:"maxCpus"`
	MaxPids     int64   `json:"maxPids"`
	GatewayPort int `json:"gatewayPort,omitempty"`
}

// strictDecode decodes data into out and rejects unknown keys.
func strictDecode(data []byte, out any) error {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return err
	}
	if dec.More() {
		return fmt.Errorf("trailing JSON content")
	}
	return nil
}

func main() {
	configPath := flag.String("config", "", "path to the JSON configuration")
	check := flag.Bool("check-config", false, "validate the configuration and exit")
	flag.Parse()
	if *configPath == "" {
		log.Fatal("--config is required")
	}
	raw, err := os.ReadFile(*configPath)
	if err != nil {
		log.Fatalf("read config: %v", err)
	}
	var cfg config
	if err := strictDecode(raw, &cfg); err != nil {
		log.Fatalf("config is invalid: %v", err)
	}
	if err := validate(&cfg); err != nil {
		log.Fatalf("config is invalid: %v", err)
	}
	if *check {
		fmt.Println("configuration is valid")
		return
	}
	docker := newSocketDocker(cfg.Upstream)
	defer docker.close()
	srv := &server{cfg: &cfg, docker: docker}
	http.HandleFunc("/v1/bots", srv.requireAuth(srv.list))
	http.HandleFunc("/v1/bots/", srv.requireAuth(srv.route))
	http.HandleFunc("/v1/health", srv.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed)
			return
		}
		var stat syscall.Statfs_t
		if err := syscall.Statfs("/", &stat); err != nil {
			http.Error(w, "resources_unavailable", 503)
			return
		}
		writeJSON(w, map[string]any{"resources": map[string]uint64{"diskFree": stat.Bavail * uint64(stat.Bsize)}, "egressCheck": map[string]string{"ifconfigIp": cfg.EgressIP, "expected": "NL"}})
	}))
	log.Printf("fleetd listening on %s", cfg.Listen)
	log.Fatal(http.ListenAndServeTLS(cfg.Listen, cfg.TLSCert, cfg.TLSKey, tlsConfig(cfg.TLSClientCA)))
}

func tlsConfig(caPath string) *tls.Config {
	caPEM, err := os.ReadFile(caPath)
	if err != nil { log.Fatalf("read client CA: %v", err) }
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) { log.Fatal("client CA contains no certificates") }
	return &tls.Config{MinVersion:tls.VersionTLS12, ClientAuth:tls.RequireAndVerifyClientCert, ClientCAs:pool}
}

func validate(cfg *config) error {
	if cfg.Listen == "" {
		return fmt.Errorf("listen is required (host:port)")
	}
	if len(cfg.Token) < 32 {
		return fmt.Errorf("token must be at least 32 characters")
	}
	if cfg.Upstream == "" {
		cfg.Upstream = "/var/run/docker.sock"
	}
	if len(cfg.Bots) == 0 {
		return fmt.Errorf("at least one bots[] entry is required")
	}
	for i := range cfg.Bots {
		b := &cfg.Bots[i]
		if b.BotKey == "" || !validBotKey(b.BotKey) {
			return fmt.Errorf("bots[%d].botKey %q is invalid", i, b.BotKey)
		}
		if b.MaxMemoryMb <= 0 || b.MaxCpus <= 0 || b.MaxPids <= 0 {
			return fmt.Errorf("bots[%d] limits must be positive", i)
		}
		for j:=0;j<i;j++ { if cfg.Bots[j].BotKey==b.BotKey{return fmt.Errorf("duplicate bot key %q",b.BotKey)} }
	}
	if cfg.VolumeRoot==""||!safeAbs(cfg.VolumeRoot){return fmt.Errorf("volumeRoot must be a safe absolute path")}
	if cfg.Network==""||len(cfg.ImageAllowlist)==0{return fmt.Errorf("network and imageAllowlist are required")}
	if cfg.GatewayPortStart<1024||cfg.GatewayPortEnd<cfg.GatewayPortStart||cfg.GatewayPortEnd>65535{return fmt.Errorf("gateway port range is invalid")}
	if cfg.TLSCert==""||cfg.TLSKey==""||cfg.TLSClientCA==""{return fmt.Errorf("tlsCert, tlsKey and tlsClientCA are required")}
	for i:=range cfg.Bots { if cfg.Bots[i].GatewayPort!=0 { if cfg.Bots[i].GatewayPort<cfg.GatewayPortStart||cfg.Bots[i].GatewayPort>cfg.GatewayPortEnd{return fmt.Errorf("bots[%d].gatewayPort is outside range",i)};for j:=0;j<i;j++{if cfg.Bots[j].GatewayPort==cfg.Bots[i].GatewayPort{return fmt.Errorf("duplicate gateway port")}} } }
	return nil
}

func validBotKey(key string) bool {
	if len(key) < 1 || len(key) > 63 {
		return false
	}
	for i := 0; i < len(key); i++ {
		c := key[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return c(key[0]) != '-' && c(key[len(key)-1]) != '-'
}

type c byte

func (c c) in(set string) bool { return strings.ContainsRune(set, rune(c)) }

// server holds the per-request state; the Docker backend wiring is added by
// later commits (this one establishes the service skeleton, config check and
// the auth gate).
type server struct {
	cfg *config
	docker dockerEngine
}

func (s *server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		const prefix = "Bearer "
		if len(auth) <= len(prefix) || auth[:len(prefix)] != prefix || auth[len(prefix):] != s.cfg.Token {
			http.Error(w, "invalid_token", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// list answers GET /v1/bots.
func (s *server) list(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed)
		return
	}
	bots := make([]botStatus, 0, len(s.cfg.Bots))
	for _, b := range s.cfg.Bots {
		x,ok,err:=s.inspect(r.Context(),b.BotKey);if err!=nil{http.Error(w,"docker_unavailable",503);return};if ok{bots=append(bots,s.toStatus(b.BotKey,x))}else{bots=append(bots,botStatus{BotKey:b.BotKey,State:"missing"})}
	}
	writeJSON(w, map[string]any{"bots": bots})
}

// route dispatches /v1/bots/{botKey}/... by method and suffix.
func (s *server) route(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/v1/bots/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) == 0 || !validBotKey(parts[0]) {
		http.Error(w, "bad_bot_key", http.StatusBadRequest)
		return
	}
	botKey := parts[0]
	if len(parts) == 1 {
		http.Error(w, "route_not_allowed", http.StatusForbidden)
		return
	}
	action := parts[1]
	if !s.enrolled(botKey) {
		http.Error(w, "bot_not_enrolled", http.StatusForbidden)
		return
	}
	switch {
	case action == "status" && r.Method == http.MethodGet:
		x,ok,err:=s.inspect(r.Context(),botKey);if err!=nil{http.Error(w,"docker_unavailable",503)}else if !ok{writeJSON(w,botStatus{BotKey:botKey,State:"missing"})}else{writeJSON(w,s.toStatus(botKey,x))}
	case action == "recreate" && r.Method == http.MethodPost:
		var body struct{Spec spec `json:"spec"`};if decodeBody(r,&body)!=nil||s.checkSpec(botKey,&body.Spec)!=nil{http.Error(w,"invalid_spec",400);return};if err:=s.validateCreate(body.Spec);err!=nil{writeAPIError(w,err);return};if _,ok,err:=s.inspect(r.Context(),botKey);err!=nil{http.Error(w,"docker_unavailable",503);return}else if ok{s.docker.call(r.Context(),http.MethodDelete,dockerAPIPrefix+"/containers/"+encodedName(botKey)+"?force=true",nil)};if err:=s.createContainer(r.Context(),body.Spec);err!=nil{writeAPIError(w,err);return};writeJSON(w,map[string]bool{"ok":true})
	case action == "start" && r.Method == http.MethodPost, action == "restart" && r.Method == http.MethodPost, action == "stop" && r.Method == http.MethodPost:
		verb:=map[string]string{"start":"start","restart":"restart?t=10","stop":"stop?t=10"}[action];status,_,err:=s.docker.call(r.Context(),http.MethodPost,dockerAPIPrefix+"/containers/"+encodedName(botKey)+"/"+verb,nil);if err!=nil{http.Error(w,"docker_unavailable",503)}else if status==404{http.Error(w,"container_missing",404)}else if status!=204&&status!=304{http.Error(w,"docker_operation_failed",502)}else{writeJSON(w,map[string]bool{"ok":true})}
	case action == "profile" && r.Method == http.MethodPut:
		var body struct{Profile profile `json:"profile"`};if decodeBody(r,&body)!=nil||body.Profile.BotKey!=botKey{http.Error(w,"invalid_profile",400);return};if err:=s.writeProfile(body.Profile);err!=nil{writeAPIError(w,err);return};writeJSON(w,map[string]bool{"ok":true})
	case action == "logs" && r.Method == http.MethodGet:
		tail:=r.URL.Query().Get("tail");if tail==""{tail="100"};status,b,err:=s.docker.call(r.Context(),http.MethodGet,dockerAPIPrefix+"/containers/"+encodedName(botKey)+"/logs?stdout=1&stderr=1&tail="+url.QueryEscape(tail)+"&timestamps=1",nil);if err!=nil||!dockerOK(status){http.Error(w,"logs_unavailable",502);return};w.Header().Set("Content-Type","text/plain; charset=utf-8");_,_=w.Write(redactLogs(b))
	case action == "template-drift" && r.Method == http.MethodPost:
		var body struct {
			Spec spec `json:"spec"`
		}
		if err := decodeBody(r, &body); err != nil {
			http.Error(w, "body_not_allowed", http.StatusBadRequest)
			return
		}
		if err := s.checkSpec(botKey, &body.Spec); err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		x,ok,err:=s.inspect(r.Context(),botKey);if err!=nil{http.Error(w,"docker_unavailable",503)}else if !ok{writeJSON(w,map[string]any{"drift":true,"fields":[]string{"missing"}})}else{fields:=driftFields(body.Spec,x);writeJSON(w,map[string]any{"drift":len(fields)>0,"fields":fields})}
	default:
		if r.Method == http.MethodPost || r.Method == http.MethodPut {
			http.Error(w, "route_not_allowed", http.StatusForbidden)
			return
		}
		http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed)
	}
}

func (s *server) enrolled(botKey string) bool {
	for i := range s.cfg.Bots {
		if s.cfg.Bots[i].BotKey == botKey {
			return true
		}
	}
	return false
}

// checkSpec enforces the enrolled limits for the bot (a full create-body
// policy lands with the Docker wiring; the limits check is the seam).
func (s *server) checkSpec(botKey string, sp *spec) error {
	if sp.BotKey != botKey {
		return fmt.Errorf("name_label_mismatch")
	}
	for i := range s.cfg.Bots {
		b := &s.cfg.Bots[i]
		if b.BotKey != botKey {
			continue
		}
		if sp.MemoryMb > b.MaxMemoryMb {
			return fmt.Errorf("limit_exceeds_enrollment")
		}
		if sp.Cpus > b.MaxCpus {
			return fmt.Errorf("limit_exceeds_enrollment")
		}
		if sp.PidsLimit > b.MaxPids {
			return fmt.Errorf("limit_exceeds_enrollment")
		}
		return nil
	}
	return fmt.Errorf("bot_not_enrolled")
}

func decodeBody(r *http.Request, out any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(out)
}

func writeJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

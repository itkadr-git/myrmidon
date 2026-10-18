package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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

const dockerAPIPrefix = "/v1.45"

type dockerEngine interface {
	call(context.Context, string, string, []byte) (int, []byte, error)
}
type socketDocker struct {
	socket string
	client *http.Client
	transport *http.Transport
}

func newSocketDocker(socket string) *socketDocker {
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return (&net.Dialer{}).DialContext(ctx, "unix", socket) }, DisableCompression:true}
	return &socketDocker{socket:socket, transport:tr, client:&http.Client{Transport:tr, CheckRedirect:func(*http.Request, []*http.Request) error{return http.ErrUseLastResponse}}}
}
func (d *socketDocker) call(ctx context.Context, method, target string, body []byte) (int, []byte, error) {
	path, query, _ := strings.Cut(target, "?")
	var reader io.Reader
	if body != nil { reader=bytes.NewReader(body) }
	req, err:=http.NewRequestWithContext(ctx,method,"http://docker/",reader); if err!=nil{return 0,nil,err}
	req.URL=&url.URL{Scheme:"http",Host:"docker",Opaque:path,RawQuery:query}; req.Host="docker"
	if body!=nil { req.Header.Set("Content-Type","application/json"); req.ContentLength=int64(len(body)) }
	resp,err:=d.client.Do(req); if err!=nil{return 0,nil,err}; defer resp.Body.Close()
	b,err:=io.ReadAll(io.LimitReader(resp.Body,16<<20)); if err!=nil{return 0,nil,err}; if len(b)>=16<<20{return resp.StatusCode,nil,errors.New("docker response too large")}; return resp.StatusCode,b,nil
}
func (d *socketDocker) close(){d.transport.CloseIdleConnections()}

func (s *server) dockerCall(ctx context.Context, method, target string, payload any) (int, []byte, error) {
	body,err:=json.Marshal(payload); if err!=nil{return 0,nil,err}; return s.docker.call(ctx,method,dockerAPIPrefix+target,body)
}
func (s *server) dockerGet(ctx context.Context, target string) (int, []byte, error) { return s.docker.call(ctx,http.MethodGet,dockerAPIPrefix+target,nil) }
func dockerOK(status int) bool{return status>=200&&status<300}
func dockerError(status int) error { return fmt.Errorf("docker operation failed (status %d)",status) }

type dockerInspect struct {
	ID string `json:"Id"`
	Image string `json:"Image"`
	Config struct { Image string `json:"Image"`; Labels map[string]string `json:"Labels"` } `json:"Config"`
	State struct { Status string `json:"Status"`; Running bool `json:"Running"`; Health *struct{Status string `json:"Status"`} `json:"Health"` } `json:"State"`
	HostConfig struct { Memory int64 `json:"Memory"`; NanoCPUs int64 `json:"NanoCpus"`; PidsLimit int64 `json:"PidsLimit"`; NetworkMode string `json:"NetworkMode"`; Binds []string `json:"Binds"`; ReadonlyRootfs bool `json:"ReadonlyRootfs"`; CapDrop []string `json:"CapDrop"`; SecurityOpt []string `json:"SecurityOpt"`; ShmSize int64 `json:"ShmSize"`; PortBindings map[string][]struct{HostPort string `json:"HostPort"`} `json:"PortBindings"`; RestartPolicy struct{Name string `json:"Name"`} `json:"RestartPolicy"` } `json:"HostConfig"`
}
func containerName(key string) string{return "myrmidon-bot-"+key}
func encodedName(key string) string{return url.QueryEscape(containerName(key))}
func (s *server) inspect(ctx context.Context,key string)(*dockerInspect,bool,error){status,b,err:=s.dockerGet(ctx,"/containers/"+encodedName(key)+"/json");if err!=nil{return nil,false,err};if status==http.StatusNotFound{return nil,false,nil};if !dockerOK(status){return nil,false,dockerError(status)};var x dockerInspect;if err=json.Unmarshal(b,&x);err!=nil{return nil,false,errors.New("invalid docker inspect response")};return &x,true,nil}
func (s *server) toStatus(key string,x *dockerInspect) botStatus { st:="stopped";if x.State.Running {st="running";if x.State.Health!=nil&&x.State.Health.Status=="unhealthy"{st="unhealthy"}};r,f:=s.readHashes(key);out:=botStatus{BotKey:key,State:st,Image:x.Config.Image,RestartHash:r,FilesHash:f};if port:=x.HostConfig.PortBindings["8642/tcp"];len(port)>0 { if n,err:=strconvPort(port[0].HostPort);err==nil{out.GatewayPort=n} };return out }
func strconvPort(v string)(int,error){return strconv.Atoi(v)}
func (s *server) readHashes(key string)(*string,*string){b,e:=os.ReadFile(filepath.Join(s.cfg.VolumeRoot,key,"hermes",".myrmidon","applied.json"));if e!=nil{return nil,nil};var m struct{RestartHash string `json:"restartHash"`;FilesHash string `json:"filesHash"`};if json.Unmarshal(b,&m)!=nil{return nil,nil};return &m.RestartHash,&m.FilesHash}
func (s *server) createContainer(ctx context.Context,sp spec)error{
	if !s.imageAllowed(sp.Image){return errForbidden("image_not_allowed")};if sp.Network!=s.cfg.Network{return errForbidden("network_not_allowed")};if sp.MemoryMb>s.enrolled(sp.BotKey).MaxMemoryMb||sp.Cpus>s.enrolled(sp.BotKey).MaxCpus||sp.PidsLimit>s.enrolled(sp.BotKey).MaxPids{return errForbidden("limits_exceeded")}
	binds,err:=s.binds(sp);if err!=nil{return err}
	port,err:=s.allocatePort(sp.BotKey);if err!=nil{return err}
	host:="";if s.cfg.BoardExtraHost!=""{host=s.cfg.BoardExtraHost+":"+s.cfg.BoardAddress}
	body:=map[string]any{"Image":sp.Image,"Labels":map[string]string{"myrmidon.bot":sp.BotKey,"myrmidon.managed":"fleetd"},"HostConfig":map[string]any{"Memory":sp.MemoryMb*1024*1024,"NanoCpus":int64(sp.Cpus*1e9),"PidsLimit":sp.PidsLimit,"NetworkMode":s.cfg.Network,"Binds":binds,"ReadonlyRootfs":true,"CapDrop":[]string{"ALL"},"SecurityOpt":[]string{"no-new-privileges:true"},"User":"10001:10001","ShmSize":67108864,"RestartPolicy":map[string]string{"Name":"unless-stopped"},"Tmpfs":map[string]string{"/tmp":"rw,noexec,nosuid,size=67108864"},"PortBindings":map[string][]map[string]string{"8642/tcp":{{"HostIp":"0.0.0.0","HostPort":fmt.Sprint(port)}}},"ExtraHosts":func()[]string{if host!=""{return []string{host}};return []string{}}()}}
	b,_:=json.Marshal(body);st,res,e:=s.docker.call(ctx,http.MethodPost,dockerAPIPrefix+"/containers/create?name="+url.QueryEscape(containerName(sp.BotKey)),b);if e!=nil{return e};if st==http.StatusConflict{return errConflict("container_exists")};if !dockerOK(st){return dockerError(st)}
	var created struct{ID string `json:"Id"`};if json.Unmarshal(res,&created)!=nil||created.ID==""{return errors.New("invalid docker create response")};return s.writePort(sp.BotKey,port)
}
func (s *server) binds(sp spec)([]string,error){root:=filepath.Join(s.cfg.VolumeRoot,sp.BotKey);for _,d:=range []string{"hermes","workspace","scratch"}{if err:=os.MkdirAll(filepath.Join(root,d),0700);err!=nil{return nil,err}};binds:=[]string{root+":/home/bot/data"};for _,m:=range sp.ExtraMounts{if !m.ReadOnly||!s.allowedMount(m.Source){return nil,errForbidden("mount_not_allowed")};if !safeAbs(m.Source)||!safeAbs(m.ContainerPath)||reservedMount(m.ContainerPath){return nil,errForbidden("mount_not_allowed")};binds=append(binds,m.Source+":"+m.ContainerPath+":ro")};if sp.SharedMount!=nil{source:=sp.SharedMount.HostPath;if source==""{source=filepath.Join(s.cfg.VolumeRoot,"shared")};if !safeAbs(source){return nil,errForbidden("mount_not_allowed")};mode:="ro";if sp.SharedMount.Writable{mode="rw"};binds=append(binds,source+":/shared:"+mode)};return binds,nil}
func safeAbs(p string)bool{if !filepath.IsAbs(p)||p=="/"||strings.Contains(p,"\\")||strings.Contains(p,"//")||strings.HasSuffix(p,"/"){return false};for _,x:=range strings.Split(p,"/"){if x=="."||x==".."{return false}};return true}
func reservedMount(p string)bool{for _,x:=range []string{"/home/bot/data","/opt/devbuild-ssh","/shared","/tmp","/run","/proc","/sys","/dev"}{if p==x||strings.HasPrefix(p,x+"/"){return true}};return false}
func (s *server) writePort(k string,p int)error{path:=filepath.Join(s.cfg.VolumeRoot,k,".gateway-port");return os.WriteFile(path,[]byte(fmt.Sprint(p)),0600)}
func errForbidden(reason string)error{return &apiError{status:403,reason:reason}}
func errConflict(reason string)error{return &apiError{status:409,reason:reason}}
type apiError struct{status int;reason string};func(e *apiError)Error()string{return e.reason}

func (s *server) imageAllowed(image string)bool{if !strings.Contains(image,"@sha256:"){return false};for _,g:=range s.cfg.ImageAllowlist{prefix,_,ok:=strings.Cut(g,"*");if ok&&strings.HasPrefix(image,prefix){return true};if !ok&&image==g{return true}};return false}
func (s *server) allowedMount(path string)bool{for _,x:=range s.cfg.MountSources{if path==x{return true}};return false}
func isNotExist(status int)bool{return status==http.StatusNotFound}
func cleanupError(err error)string{if err==nil{return ""};return err.Error()}
func systemResources()map[string]any{var st syscallStatfs;_ = st;return map[string]any{"diskFree":uint64(0)}}
var _ = time.Second
var _ = os.ErrNotExist

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const defaultBridge = "http://127.0.0.1:8768"

var client = &http.Client{Timeout: 1800 * time.Millisecond, Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: time.Second}).DialContext}}

type activity struct {
	At        string `json:"at"`
	Component string `json:"component"`
	Phase     string `json:"phase"`
	Detail    string `json:"detail"`
}
type task struct {
	Phase     string `json:"phase"`
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	StartedAt string `json:"started_at"`
	Active    int    `json:"active"`
	Completed int    `json:"completed"`
	Failed    int    `json:"failed"`
}
type voice struct {
	State  string `json:"state"`
	Loaded bool   `json:"loaded"`
	Model  string `json:"model"`
	Error  string `json:"error"`
}
type partyMember struct {
	Name       string   `json:"name"`
	Class      string   `json:"class"`
	Level      any      `json:"level"`
	HP         any      `json:"hp"`
	MaxHP      any      `json:"max_hp"`
	AC         any      `json:"ac"`
	Conditions []string `json:"conditions"`
}
type party struct {
	Campaign   string        `json:"campaign"`
	Session    any           `json:"session"`
	Scene      string        `json:"scene"`
	Location   string        `json:"location"`
	Role       string        `json:"role"`
	UpdatedAt  string        `json:"updated_at"`
	Characters []partyMember `json:"characters"`
	Players    int           `json:"players"`
	Encounter  string        `json:"encounter"`
}
type status struct {
	Online        bool       `json:"online"`
	Version       int        `json:"version"`
	PID           int        `json:"pid"`
	UptimeSeconds int        `json:"uptime_seconds"`
	DM            task       `json:"dm"`
	Audio         task       `json:"audio"`
	Kitten        voice      `json:"kitten"`
	FastVoice     voice      `json:"fast_voice"`
	Party         party      `json:"party"`
	Events        []activity `json:"events"`
	Providers     []provider `json:"-"`
}
type provider struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Status    string `json:"status"`
	Installed bool   `json:"installed"`
	Kind      string `json:"kind"`
}

func fetchStatus(ctx context.Context) (status, error) {
	var s status
	req, err := http.NewRequestWithContext(ctx, "GET", defaultBridge+"/api/bridge/status", nil)
	if err != nil {
		return s, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return s, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return s, fmt.Errorf("Bridge status HTTP %d (upgrade the Python runtime)", resp.StatusCode)
	}
	err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&s)
	return s, err
}
func fetchProviders(ctx context.Context) []provider {
	req, err := http.NewRequestWithContext(ctx, "GET", defaultBridge+"/api/providers", nil)
	if err != nil {
		return nil
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var v struct {
		Providers []provider `json:"providers"`
	}
	if resp.StatusCode != 200 || json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&v) != nil {
		return nil
	}
	return v.Providers
}
func configDir() (string, error) {
	if root := os.Getenv("LANTERN_CONFIG_DIR"); root != "" {
		return root, nil
	}
	root, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "lantern-table"), nil
}
func runtimeDir() (string, error) {
	root, err := configDir()
	if err != nil {
		return "", err
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	return root, nil
}
func logPath() string {
	root, err := runtimeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(root, "bridge.log")
}
func pidPath() string {
	root, err := runtimeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(root, "bridge-daemon.pid")
}
func bridgeScript() (string, error) {
	if custom := os.Getenv("LANTERN_BRIDGE_SCRIPT"); custom != "" {
		if abs, err := filepath.Abs(custom); err == nil {
			return abs, nil
		}
		return custom, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	candidates := []string{
		filepath.Join(filepath.Dir(exe), "bridge", "dnd_chatgpt_server.py"),
		filepath.Join(filepath.Dir(exe), "..", "bridge", "dnd_chatgpt_server.py"),
		"dnd_chatgpt_server.py",
	}
	for _, name := range candidates {
		if _, err := os.Stat(name); err == nil {
			return filepath.Abs(name)
		}
	}
	return "", errors.New("Bridge runtime not found; install a Lantern release or set LANTERN_BRIDGE_SCRIPT")
}
func uvExecutable() string {
	if path := os.Getenv("LANTERN_UV_BIN"); path != "" {
		return path
	}
	exe, err := os.Executable()
	if err == nil {
		for _, v := range []string{filepath.Join(filepath.Dir(exe), "bridge", "uv"), filepath.Join(filepath.Dir(exe), "..", "bridge", "uv")} {
			if info, err := os.Stat(v); err == nil && !info.IsDir() {
				return v
			}
		}
	}
	if p, err := exec.LookPath("uv"); err == nil {
		return p
	}
	return ""
}
func running(ctx context.Context) bool { s, err := fetchStatus(ctx); return err == nil && s.Online }
func readPID() (int, error) {
	b, err := os.ReadFile(pidPath())
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(b)))
}
func isLanternDaemon(pid int) bool {
	if pid < 1 {
		return false
	}
	if runtime.GOOS == "linux" {
		cmdline, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
		if err != nil {
			return false
		}
		// Ensure an unrelated process cannot be killed after PID reuse.
		parts := strings.Split(string(cmdline), "\x00")
		return len(parts) > 1 && filepath.Base(parts[0]) == "lantern" && parts[1] == "daemon"
	}
	// On macOS, inspect argv rather than trusting a stale pidfile.
	if runtime.GOOS == "darwin" {
		output, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "command=").Output()
		return err == nil && strings.Contains(string(output), "lantern daemon")
	}
	return false
}
func spawn() error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if running(ctx) {
		return nil
	}
	if pid, err := readPID(); err == nil && isLanternDaemon(pid) {
		return nil
	}
	if _, err := bridgeScript(); err != nil {
		return err
	}
	if uvExecutable() == "" {
		return errors.New("uv is required: install a release containing bridge/uv or install uv from astral.sh")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "daemon")
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.SysProcAttr = detachedProcessAttrs()
	if err = cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
func stop() error {
	pid, err := readPID()
	if err != nil {
		return errors.New("no Lantern-managed Bridge daemon found")
	}
	if !isLanternDaemon(pid) {
		return errors.New("pidfile is stale or Bridge is externally managed; refusing to signal an unrelated process")
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Signal(syscall.SIGTERM)
}
func daemon() error {
	root, err := runtimeDir()
	if err != nil {
		return err
	}
	pidfile := filepath.Join(root, "bridge-daemon.pid")
	// Only one daemon may manage the local Python worker.
	if pid, err := readPID(); err == nil && isLanternDaemon(pid) && pid != os.Getpid() {
		return errors.New("Lantern daemon already active")
	}
	lock, err := os.OpenFile(pidfile, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if os.IsExist(err) {
		_ = os.Remove(pidfile)
		lock, err = os.OpenFile(pidfile, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	}
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintln(lock, os.Getpid())
	_ = lock.Close()
	defer os.Remove(pidfile)
	log, err := os.OpenFile(logPath(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	script, err := bridgeScript()
	if err != nil {
		return err
	}
	uv := uvExecutable()
	if uv == "" {
		return errors.New("uv is not installed")
	}
	ctx, halt := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer halt()
	for attempt := 0; ; attempt++ {
		if ctx.Err() != nil {
			return nil
		}
		probe, cancel := context.WithTimeout(ctx, time.Second)
		occupied := running(probe)
		cancel()
		if occupied {
			fmt.Fprintln(log, "Bridge port already owned by another process; daemon will not spawn duplicate")
			return nil
		}
		cmd := exec.CommandContext(ctx, uv, "run", "--script", script)
		cmd.Env = append(os.Environ(), "LANTERN_MODE=companion", "LANTERN_RELOAD=0", "PYTHONUNBUFFERED=1")
		cmd.Dir = filepath.Dir(script)
		cmd.Stdout = log
		cmd.Stderr = log
		fmt.Fprintf(log, "--- Lantern Bridge starting at %s ---\n", time.Now().Format(time.RFC3339))
		if err := cmd.Start(); err != nil {
			return err
		}
		err := cmd.Wait()
		if ctx.Err() != nil {
			return nil
		}
		fmt.Fprintf(log, "Bridge exited: %v\n", err)
		if attempt >= 4 {
			return fmt.Errorf("Bridge exited repeatedly: %w", err)
		}
		time.Sleep(time.Duration(attempt+1) * time.Second)
	}
}
func tailLogs(n int) string {
	b, err := os.ReadFile(logPath())
	if err != nil {
		return "No log file yet. Start the Bridge to see logs."
	}
	// bound rendered data even when a log has grown large
	if len(b) > 256*1024 {
		b = b[len(b)-256*1024:]
	}
	lines := strings.Split(strings.TrimRight(string(b), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
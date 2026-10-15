package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStatusContract(t *testing.T) {
	const input = `{"online":true,"version":1,"pid":101,"dm":{"phase":"streaming","provider":"ollama","active":1},"audio":{"phase":"synthesizing","active":1},"party":{"campaign":"Test","characters":[{"name":"A","hp":3,"max_hp":10,"conditions":["Poisoned"]}]},"events":[{"at":"2026-10-15T12:00:00+00:00","component":"dm","phase":"started"}]}`
	var s status
	if err := json.Unmarshal([]byte(input), &s); err != nil {
		t.Fatal(err)
	}
	if !s.Online || s.Version != 1 || s.DM.Phase != "streaming" || s.Audio.Active != 1 || len(s.Party.Characters) != 1 {
		t.Fatalf("unexpected status: %+v", s)
	}
	if v, ok := number(s.Party.Characters[0].HP); !ok || v != 3 {
		t.Fatal("health not decoded")
	}
}
func TestPathsAndLogTail(t *testing.T) {
	t.Setenv("LANTERN_CONFIG_DIR", t.TempDir())
	path := logPath()
	if !strings.HasPrefix(path, os.Getenv("LANTERN_CONFIG_DIR")) {
		t.Fatalf("wrong log path: %q", path)
	}
	if err := os.WriteFile(path, []byte("one\ntwo\nthree\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := tailLogs(2); got != "two\nthree" {
		t.Fatalf("tail: %q", got)
	}
	if _, err := os.Stat(filepath.Dir(pidPath())); err != nil {
		t.Fatal(err)
	}
}
func TestUnknownCommand(t *testing.T) {
	if err := mainErr([]string{"not-a-command"}); err == nil {
		t.Fatal("expected error")
	}
}
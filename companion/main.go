package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

var buildVersion = "dev"

func main() {
	if err := mainErr(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "lantern:", err)
		os.Exit(1)
	}
}
func mainErr(args []string) error {
	action := "tui"
	if len(args) > 0 {
		action = args[0]
	}
	switch action {
	case "tui":
		_, err := tea.NewProgram(model{selected: 0, statusErr: fmt.Errorf("connecting")}).Run()
		return err
	case "start":
		if err := spawn(); err != nil {
			return err
		}
		fmt.Println("Starting Lantern Bridge; use 'lantern status' or 'lantern logs' to inspect startup.")
	case "stop":
		return stop()
	case "restart":
        return restartManaged()
	case "daemon":
		return daemon()
	case "status":
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		s, err := fetchStatus(ctx)
		if err != nil {
			return err
		}
		if len(args) > 1 && args[1] == "--json" {
			return json.NewEncoder(os.Stdout).Encode(s)
		}
		fmt.Printf("Bridge online · pid %d · DM %s (%s) · Audio %s\n", s.PID, phase(s.DM.Phase), empty(s.DM.Provider, "none"), phase(s.Audio.Phase))
	case "logs":
		fmt.Println(tailLogs(120))
	case "doctor":
		_, err := bridgeScript()
		report("Bridge resources", err)
		if uvExecutable() == "" {
			report("uv", fmt.Errorf("missing: install a released Lantern archive or uv"))
		} else {
			report("uv", nil)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, err = fetchStatus(ctx)
		report("Bridge API", err)
		if _, execErr := exec.LookPath("codex"); execErr == nil {
			report("Codex CLI", nil)
		} else {
			fmt.Println("INFO Codex CLI not installed (optional)")
		}
		fmt.Println("Runtime config:", strings.TrimSuffix(pidPath(), "bridge-daemon.pid"))
	case "version", "--version", "-v":
		fmt.Println("lantern", buildVersion)
	case "help", "--help", "-h":
		fmt.Println("lantern [tui|start|stop|restart|status [--json]|logs|doctor|version]")
	default:
		return fmt.Errorf("unknown command %q; use 'lantern help'", action)
	}
	return nil
}
func report(name string, err error) {
	if err != nil {
		fmt.Println("FAIL", name, "·", err)
	} else {
		fmt.Println("OK  ", name)
	}
}
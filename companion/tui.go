package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

var tabs = []string{"Overview", "Logs", "Characters", "AI", "Campaign", "Settings"}
var (
	accent     = lipgloss.Color("#e6ab68")
	green      = lipgloss.Color("#7ed8a0")
	muted      = lipgloss.Color("#a1a0aa")
	red        = lipgloss.Color("#f3828d")
	titleStyle = lipgloss.NewStyle().Bold(true).Foreground(accent)
	soft       = lipgloss.NewStyle().Foreground(muted)
	good       = lipgloss.NewStyle().Foreground(green)
	bad        = lipgloss.NewStyle().Foreground(red)
	panel      = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(lipgloss.Color("#605463")).Padding(1, 2)
)

type tickMsg time.Time
type stateMsg struct {
	Status status
	Err    error
}
type providersMsg []provider
type actionMsg struct {
	Text string
	Err  error
}

type model struct {
	width, height int
	selected      int
	logOffset     int
	current       status
	providers     []provider
	statusErr     error
	notice        string
	lastProviders time.Time
	showHelp      bool
}

func (m model) Init() tea.Cmd { return tea.Batch(readBridge(), clock()) }
func clock() tea.Cmd {
	return tea.Tick(1500*time.Millisecond, func(t time.Time) tea.Msg { return tickMsg(t) })
}
func readBridge() tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		s, err := fetchStatus(ctx)
		return stateMsg{Status: s, Err: err}
	}
}
func readProviders() tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		return providersMsg(fetchProviders(ctx))
	}
}
func execute(command string) tea.Cmd {
	return func() tea.Msg {
		var err error
		switch command {
		case "start":
			err = spawn()
		case "stop":
			err = stop()
		case "restart":
            err = restartManaged()
		}
		return actionMsg{Text: command, Err: err}
	}
}
func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	case tea.KeyPressMsg:
		key := msg.String()
		switch key {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "tab", "right":
			m.selected = (m.selected + 1) % len(tabs)
		case "shift+tab", "left":
			m.selected = (m.selected + len(tabs) - 1) % len(tabs)
		case "?":
			m.showHelp = !m.showHelp
		case "s":
			m.notice = "Starting Bridge…"
			return m, execute("start")
		case "x":
			m.notice = "Stopping Bridge…"
			return m, execute("stop")
		case "r":
			m.notice = "Restarting Bridge…"
			return m, execute("restart")
		case "up", "k":
			m.logOffset++
		case "down", "j":
			if m.logOffset > 0 {
				m.logOffset--
			}
		default:
			if len(key) == 1 && key[0] >= '1' && key[0] <= '6' {
				m.selected = int(key[0] - '1')
				m.logOffset = 0
			}
		}
	case tickMsg:
		cmds := []tea.Cmd{readBridge(), clock()}
		if time.Since(m.lastProviders) > 12*time.Second {
			m.lastProviders = time.Now()
			cmds = append(cmds, readProviders())
		}
		return m, tea.Batch(cmds...)
	case stateMsg:
		m.statusErr = msg.Err
		if msg.Err == nil {
			m.current = msg.Status
		}
	case providersMsg:
		m.providers = []provider(msg)
	case actionMsg:
		if msg.Err != nil {
			m.notice = fmt.Sprintf("%s: %v", msg.Text, msg.Err)
		} else {
			m.notice = fmt.Sprintf("%s requested", msg.Text)
		}
		return m, readBridge()
	}
	return m, nil
}
func (m model) View() tea.View {
	width := m.width
	if width < 48 {
		width = 80
	}
	if width > 112 {
		width = 112
	}
	var body strings.Builder
	state := "Bridge offline"
	if m.statusErr == nil && m.current.Online {
		state = good.Render("● ONLINE")
	}
	body.WriteString(titleStyle.Render("◆ LANTERN BRIDGE") + "  " + state + "\n\n")
	for i, t := range tabs {
		name := fmt.Sprintf(" %d:%s ", i+1, t)
		if i == m.selected {
			name = lipgloss.NewStyle().Foreground(lipgloss.Color("#16151c")).Background(accent).Bold(true).Render(name)
		} else {
			name = soft.Render(name)
		}
		if i == 3 {
			body.WriteString("\n")
		}
		body.WriteString(name + " ")
	}
	body.WriteString("\n\n")
	var content string
	switch m.selected {
	case 0:
		content = m.overview()
	case 1:
		content = m.logs()
	case 2:
		content = m.characters()
	case 3:
		content = m.ai()
	case 4:
		content = m.campaign()
	case 5:
		content = m.settings()
	}
	body.WriteString(panel.Width(width - 8).Render(content))
	if m.notice != "" {
		body.WriteString("\n" + soft.Render(m.notice))
	}
	body.WriteString("\n\n" + soft.Render("1–6 Tabs  │  s Start  x Stop  r Restart  ↑↓ Scroll  ? Help  q Detach"))
	if m.showHelp {
		body.WriteString("\n" + soft.Render("Quitting detaches the UI; Bridge continues. Stop affects only Lantern-managed daemons."))
	}
	view := tea.NewView(body.String())
	return view
}
func (m model) overview() string {
	if m.statusErr != nil {
		return "Bridge unavailable: " + m.statusErr.Error() + "\n\nPress [s] to start the Bridge or run 'lantern doctor'."
	}
	s := m.current
	msg := []string{
		titleStyle.Render("LOCAL SERVICE"),
		fmt.Sprintf("Address       %s", defaultBridge),
		fmt.Sprintf("PID           %d  ·  Uptime %s", s.PID, (time.Duration(s.UptimeSeconds) * time.Second).Truncate(time.Second)),
		fmt.Sprintf("DM            %s  (%s / %s)", phase(s.DM.Phase), empty(s.DM.Provider, "not selected"), empty(s.DM.Model, "default")),
		fmt.Sprintf("Audio         %s  ·  %d active", phase(s.Audio.Phase), s.Audio.Active),
		fmt.Sprintf("KittenTTS     %s · %s", phase(s.Kitten.State), empty(s.Kitten.Model, "no model")),
		fmt.Sprintf("Party         %d characters  ·  %s", len(s.Party.Characters), empty(s.Party.Campaign, "no host snapshot")),
		"", titleStyle.Render("RECENT ACTIVITY"),
	}
	n := len(s.Events)
	if n > 8 {
		n = 8
	}
	for _, e := range s.Events[len(s.Events)-n:] {
		msg = append(msg, fmt.Sprintf("%-9s %-7s %-13s %s", shortTime(e.At), e.Component, e.Phase, e.Detail))
	}
	if n == 0 {
		msg = append(msg, "No requests recorded yet.")
	}
	return strings.Join(msg, "\n")
}
func (m model) logs() string {
	rows := 14
	if m.height > 35 {
		rows = m.height - 17
	}
	lines := strings.Split(tailLogs(200), "\n")
	end := len(lines) - m.logOffset
	if end < 0 {
		end = 0
	}
	start := end - rows
	if start < 0 {
		start = 0
	}
	return titleStyle.Render("BRIDGE LOGS  ·  ↑↓ scroll  ·  s/start x/stop r/restart") + "\n\n" + strings.Join(lines[start:end], "\n")
}
func (m model) characters() string {
	p := m.current.Party
	if len(p.Characters) == 0 {
		return titleStyle.Render("PARTY ROSTER") + "\n\nOpen the hosted campaign as its host.\nThis tab updates when the browser shares a read-only party summary.\nNothing is stored by Lantern's public server."
	}
	lines := []string{titleStyle.Render("PARTY ROSTER") + "  " + soft.Render("host-reported snapshot"), fmt.Sprintf("%s · session %v · %s", p.Campaign, p.Session, p.Scene), ""}
	for _, c := range p.Characters {
		conditions := ""
		if len(c.Conditions) > 0 {
			conditions = " · " + strings.Join(c.Conditions, ", ")
		}
		lines = append(lines, fmt.Sprintf("%-21s  Lv %-3v %-16s HP %-5v/%-5v  AC %-3v%s", c.Name, c.Level, c.Class, c.HP, c.MaxHP, c.AC, conditions))
	}
	return strings.Join(lines, "\n")
}
func (m model) ai() string {
	lines := []string{titleStyle.Render("AI CONNECTIONS") + "  " + soft.Render("Provider readiness is separate from active generation"), ""}
	if len(m.providers) == 0 {
		lines = append(lines, "Checking installed runtimes…")
	}
	for _, p := range m.providers {
		flag := "○"
		if p.Status == "connected" {
			flag = "●"
		}
		name := p.ID
		if p.Name != "" && len(p.Name) < 26 {
			name = p.Name
		}
		lines = append(lines, fmt.Sprintf("%s %-22s %-18s %s", flag, name, p.Status, p.Kind))
	}
	lines = append(lines, "", fmt.Sprintf("Active DM: %s · %s", empty(m.current.DM.Provider, "none"), phase(m.current.DM.Phase)))
	lines = append(lines, "Connections are configured on the host in the Lantern Table web UI.")
	return strings.Join(lines, "\n")
}
func (m model) campaign() string {
	p := m.current.Party
	if p.Campaign == "" {
		return titleStyle.Render("HOST CAMPAIGN") + "\n\nNo campaign summary published yet. Start or rejoin as host in your browser."
	}
	lines := []string{titleStyle.Render("HOST CAMPAIGN"), "", fmt.Sprintf("Name        %s", p.Campaign), fmt.Sprintf("Session     %v", p.Session), fmt.Sprintf("Scene       %s", p.Scene), fmt.Sprintf("Location    %s", p.Location), fmt.Sprintf("Encounter   %s", empty(p.Encounter, "No active encounter")), fmt.Sprintf("Players     %d · Characters %d", p.Players, len(p.Characters)), "", titleStyle.Render("DM PREP CHECKLIST")}
	hurt := 0
	for _, c := range p.Characters {
		hp, ok := number(c.HP)
		max, ok2 := number(c.MaxHP)
		if ok && ok2 && max > 0 && hp/max < 0.35 {
			hurt++
		}
	}
	if hurt > 0 {
		lines = append(lines, fmt.Sprintf("• %d party members are below 35%% HP. Consider encounter difficulty.", hurt))
	}
	lines = append(lines, "• Keep agency with players; review any AI-suggested state changes.", "• Check recent character conditions and ongoing narrative threads.", "", soft.Render("Guidance is deterministic and host-only; autonomous AI coaching is not enabled."))
	return strings.Join(lines, "\n")
}
func (m model) settings() string {
	path, _ := bridgeScript()
	return strings.Join([]string{titleStyle.Render("LOCAL BRIDGE SETTINGS"), "", "Server        " + defaultBridge, "Runtime       " + empty(path, "not installed"), "Log           " + logPath(), "Config        " + pidPath(), "", "lantern start | stop | restart | status | logs | doctor", "", soft.Render("Quit detaches. Worker runs independently. No secrets appear in the TUI.")}, "\n")
}
func empty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}
func phase(s string) string {
	if s == "" {
		return "idle"
	}
	return s
}
func shortTime(s string) string {
	if len(s) >= 19 {
		return s[11:19]
	}
	return s
}
func number(v any) (float64, bool) { f, ok := v.(float64); return f, ok }
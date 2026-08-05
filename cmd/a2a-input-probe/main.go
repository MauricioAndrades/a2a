// a2a-input-probe — prints every bubbletea Msg so you can see exactly
// what your terminal/tmux is sending on plain wheel, shift+wheel, arrow
// keys, etc. Press q (or ctrl+c) to quit.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

type event struct {
	stamp string
	line  string
}

type model struct {
	events    []event
	width     int
	height    int
	tmuxState string
}

const maxEvents = 200

func (m model) Init() tea.Cmd {
	return nil
}

func push(m model, line string) model {
	m.events = append(m.events, event{
		stamp: time.Now().Format("15:04:05.000"),
		line:  line,
	})
	if len(m.events) > maxEvents {
		m.events = m.events[len(m.events)-maxEvents:]
	}
	return m
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case tea.KeyMsg:
		if msg.String() == "q" || msg.String() == "ctrl+c" {
			return m, tea.Quit
		}
		m = push(m, fmt.Sprintf("KEY     str=%q  type=%d  alt=%v  runes=%v",
			msg.String(), msg.Type, msg.Alt, msg.Runes))
		return m, nil
	case tea.MouseMsg:
		m = push(m, fmt.Sprintf("MOUSE   x=%-3d y=%-3d  button=%s  action=%s",
			msg.X, msg.Y, mouseButtonName(msg.Button), mouseActionName(msg.Action)))
		return m, nil
	}
	return m, nil
}

func mouseButtonName(b tea.MouseButton) string {
	switch b {
	case tea.MouseButtonNone:
		return "none"
	case tea.MouseButtonLeft:
		return "left"
	case tea.MouseButtonMiddle:
		return "middle"
	case tea.MouseButtonRight:
		return "right"
	case tea.MouseButtonWheelUp:
		return "wheel-up"
	case tea.MouseButtonWheelDown:
		return "wheel-down"
	case tea.MouseButtonWheelLeft:
		return "wheel-left"
	case tea.MouseButtonWheelRight:
		return "wheel-right"
	case tea.MouseButtonBackward:
		return "backward"
	case tea.MouseButtonForward:
		return "forward"
	}
	return fmt.Sprintf("btn-%d", b)
}

func mouseActionName(a tea.MouseAction) string {
	switch a {
	case tea.MouseActionPress:
		return "press"
	case tea.MouseActionRelease:
		return "release"
	case tea.MouseActionMotion:
		return "motion"
	}
	return fmt.Sprintf("act-%d", a)
}

func (m model) View() string {
	header := strings.Join([]string{
		"a2a-input-probe — scroll/click/type here",
		"q or ctrl+c quits · last events shown bottom-first",
		"tmux: " + m.tmuxState,
		strings.Repeat("─", max(20, m.width)),
	}, "\n")
	rows := make([]string, 0, len(m.events))
	for i := len(m.events) - 1; i >= 0; i-- {
		e := m.events[i]
		rows = append(rows, e.stamp+"  "+e.line)
	}
	return header + "\n" + strings.Join(rows, "\n")
}

func detectTmuxState() string {
	if os.Getenv("TMUX") == "" {
		return "not running inside tmux"
	}
	cmd := exec.Command("tmux", "display-message", "-p", "#{mouse}")
	out, err := cmd.Output()
	if err != nil {
		return "inside tmux, mouse option unknown: " + err.Error()
	}
	return "inside tmux, mouse=" + strings.TrimSpace(string(out))
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func main() {
	// If invoked with --enable-tmux-mouse and we're inside tmux, flip the
	// session mouse option on so we can directly compare before/after.
	for _, a := range os.Args[1:] {
		if a == "--enable-tmux-mouse" && os.Getenv("TMUX") != "" {
			exec.Command("tmux", "set-option", "mouse", "on").Run()
		}
	}
	m := model{tmuxState: detectTmuxState()}
	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithMouseAllMotion())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

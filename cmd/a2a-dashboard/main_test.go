package main

import (
	"strings"
	"testing"
)

func TestCommandHelpAndPaletteUseSharedCommandTable(t *testing.T) {
	help := strings.Join(commandHelpLines(80), "\n")
	if !strings.Contains(help, "1-9") {
		t.Fatalf("help should mention numbered slot opens:\n%s", help)
	}
	if !strings.Contains(help, "command palette") {
		t.Fatalf("help should mention command palette:\n%s", help)
	}

	matches := commandPaletteMatches("attention")
	if len(matches) == 0 {
		t.Fatal("expected attention command palette match")
	}
	if matches[0].ID != commandAttention {
		t.Fatalf("expected first attention match to be commandAttention, got %s", matches[0].ID)
	}

	lines := strings.Join(commandPaletteLines("raw", 1, 3), "\n")
	if !strings.Contains(lines, "raw insert") {
		t.Fatalf("expected raw command palette lines:\n%s", lines)
	}
}

func TestAttentionLinesAndAgentKeys(t *testing.T) {
	if (registeredAgent{AgentID: "lead"}).key() != "lead" {
		t.Fatal("agentId should be the primary registered agent key")
	}
	if (registeredAgent{ID: "scout"}).key() != "scout" {
		t.Fatal("id should be accepted for status-snapshot agent rows")
	}

	clear := strings.Join(attentionLines(nil, 4), "\n")
	if !strings.Contains(clear, "attention clear") {
		t.Fatalf("expected clear attention line, got %q", clear)
	}

	rows := strings.Join(attentionLines([]attentionItem{{
		Kind:     "bridge-only",
		ID:       "patcher",
		Severity: "warn",
		Message:  "patcher is registered but has no tmux session",
	}}, 4), "\n")
	if !strings.Contains(rows, "patcher") || !strings.Contains(rows, "bridge-only") {
		t.Fatalf("expected attention row details:\n%s", rows)
	}
}

func TestDashboardViewsExposeHelpPaletteAndAttention(t *testing.T) {
	model := newModel("ops-view", []member{{ID: "lead", Slot: 1}})
	model.width = 120
	model.height = 36
	model.state.Attention = []attentionItem{{
		Kind:     "tmux-only",
		ID:       "lead",
		Severity: "warn",
		Message:  "lead has tmux state but no bridge registration",
	}}

	model.mode = modeHelp
	help := stripANSI(model.View())
	if !strings.Contains(help, "Dashboard Help") || !strings.Contains(help, "1-9") {
		t.Fatalf("expected help surface in view:\n%s", help)
	}

	model.mode = modeCommandPalette
	model.paletteQuery = "attention"
	palette := stripANSI(model.View())
	if !strings.Contains(palette, "Command Palette") || !strings.Contains(palette, "attention") {
		t.Fatalf("expected command palette surface in view:\n%s", palette)
	}

	model.mode = modeNormal
	model.showAttention = true
	attention := stripANSI(model.View())
	if !strings.Contains(attention, "Attention") || !strings.Contains(attention, "lead") {
		t.Fatalf("expected attention surface in view:\n%s", attention)
	}
}

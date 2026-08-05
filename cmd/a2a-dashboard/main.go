package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type member struct {
	ID   string
	Slot int
}
type registeredAgent struct {
	AgentID string `json:"agentId"`
	ID      string `json:"id"`
	Status  string `json:"status"`
	Yolo    *bool  `json:"yolo"`
	Backend string `json:"backend"`
}

func (a registeredAgent) key() string {
	if a.AgentID != "" {
		return a.AgentID
	}
	return a.ID
}

type attentionItem struct {
	Index    int    `json:"index"`
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}
type listState struct {
	BridgeError string            `json:"bridgeError"`
	Registered  []registeredAgent `json:"registered"`
	Orphans     []string          `json:"orphans"`
	Attention   []attentionItem
}
type refreshMsg struct {
	State   listState
	Preview []string
	Err     error
}
type openMsg struct {
	Err error
}
type mode int

const (
	modeNormal mode = iota
	modeQuickOpen
	modePrompt
	modeRawInsert
	modeCommandPalette
	modeHelp
)

type pane int

const (
	paneRoster pane = iota
	panePreview
)

func (p pane) toggle() pane {
	if p == paneRoster {
		return panePreview
	}
	return paneRoster
}

type model struct {
	session       string
	members       []member
	selected      int
	rosterScroll  int
	checked       map[string]bool
	mode          mode
	focus         pane
	viewport      viewport.Model
	quickQuery    string
	promptTitle   string
	promptAction  string
	promptTargets []string
	rawTargets    []member
	rawInput      string
	rawOpenAfter  bool
	input         string
	paletteQuery  string
	paletteIndex  int
	showAttention bool
	width         int
	height        int
	state         listState
	status        string
	err           string
}

var (
	titleStyle         = lipgloss.NewStyle().Bold(true)
	mutedStyle         = lipgloss.NewStyle().Faint(true)
	activeStyle        = lipgloss.NewStyle().Bold(true).Reverse(true)
	borderStyle        = lipgloss.NewStyle().Foreground(lipgloss.Color("240"))
	focusedBorderStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("51"))
	errorStyle         = lipgloss.NewStyle().Foreground(lipgloss.Color("203"))
	okStyle            = lipgloss.NewStyle().Foreground(lipgloss.Color("120"))
	warnStyle          = lipgloss.NewStyle().Foreground(lipgloss.Color("221"))
)

type commandID string

const (
	commandOpenSelected commandID = "open-selected"
	commandSlotHelp     commandID = "slot-help"
	commandQuickOpen    commandID = "quick-open"
	commandMessage      commandID = "message"
	commandAsk          commandID = "ask"
	commandRawInsert    commandID = "raw-insert"
	commandRawOpen      commandID = "raw-open"
	commandRawMulti     commandID = "raw-multi"
	commandRawMultiOpen commandID = "raw-multi-open"
	commandSlash        commandID = "slash"
	commandMention      commandID = "mention"
	commandMark         commandID = "mark"
	commandGroupMessage commandID = "group-message"
	commandBroadcast    commandID = "broadcast"
	commandRefresh      commandID = "refresh"
	commandChooser      commandID = "chooser"
	commandToggleFocus  commandID = "toggle-focus"
	commandFocusRoster  commandID = "focus-roster"
	commandFocusPreview commandID = "focus-preview"
	commandAttention    commandID = "attention"
	commandHelp         commandID = "help"
	commandPalette      commandID = "palette"
	commandQuit         commandID = "quit"
)

type dashboardCommand struct {
	Key         string
	Name        string
	Description string
	ID          commandID
}

var dashboardCommands = []dashboardCommand{
	{"Enter", "open selected", "open the selected agent tab", commandOpenSelected},
	{"1-9", "open slot", "press a number key to open that agent slot", commandSlotHelp},
	{"q", "find agent", "filter agents by name and open the first match", commandQuickOpen},
	{"m", "message", "send a message to the selected agent", commandMessage},
	{"a", "ask", "send an ask envelope to the selected agent", commandAsk},
	{"i", "raw insert", "paste raw input into the selected pane", commandRawInsert},
	{"o", "raw insert and open", "paste raw input, then open the pane", commandRawOpen},
	{"I", "raw insert marked", "paste raw input into marked panes", commandRawMulti},
	{"O", "raw insert marked and open", "paste raw input into marked panes, then open", commandRawMultiOpen},
	{"/", "slash command", "start raw input with slash for the selected pane", commandSlash},
	{"@", "mention file", "start raw input with @ for the selected pane", commandMention},
	{"Space", "mark", "toggle the selected agent in the group target set", commandMark},
	{"g", "message marked", "message all marked agents", commandGroupMessage},
	{"b", "broadcast", "broadcast a message to all agents", commandBroadcast},
	{"r", "refresh", "refresh roster, attention, and preview state", commandRefresh},
	{"c", "tmux chooser", "open tmux choose-tree", commandChooser},
	{"Tab", "toggle focus", "move focus between roster and preview", commandToggleFocus},
	{"[", "focus roster", "focus the roster pane", commandFocusRoster},
	{"]", "focus preview", "focus the preview pane", commandFocusPreview},
	{"!", "attention", "show the runtime attention stack", commandAttention},
	{"?", "help", "show this dashboard help surface", commandHelp},
	{":", "command palette", "filter and run dashboard commands", commandPalette},
	{"x", "quit", "exit the dashboard command center", commandQuit},
}

func main() {
	var session string
	var rawMembers repeatedFlag
	flag.StringVar(&session, "session", "", "tmux dashboard session")
	flag.Var(&rawMembers, "member", "dashboard member in id:slot form")
	flag.Parse()
	if session == "" {
		fmt.Fprintln(os.Stderr, "a2a-dashboard: --session is required")
		os.Exit(2)
	}
	members := parseMembers(rawMembers)
	if len(members) == 0 {
		fmt.Fprintln(os.Stderr, "a2a-dashboard: at least one --member is required")
		os.Exit(2)
	}
	// Session-scoped tmux mouse mode so wheel events reach the app as
	// real mouse messages instead of being intercepted by tmux for pane
	// scrollback or masqueraded by the terminal as arrow keys.
	run("tmux", "set-option", "-t", session, "mouse", "on")
	p := tea.NewProgram(newModel(session, members), tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "a2a-dashboard: %v\n", err)
		os.Exit(1)
	}
}

type repeatedFlag []string

func (r *repeatedFlag) String() string {
	return strings.Join(*r, ",")
}
func (r *repeatedFlag) Set(value string) error {
	*r = append(*r, value)
	return nil
}
func parseMembers(raw []string) []member {
	out := make([]member, 0, len(raw))
	seen := map[string]bool{}
	for i, value := range raw {
		id, slot := parseMember(value, i+1)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, member{ID: id, Slot: slot})
	}
	return out
}
func parseMember(raw string, fallbackSlot int) (string, int) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fallbackSlot
	}
	idx := strings.LastIndex(value, ":")
	if idx > 0 && idx < len(value)-1 {
		id := value[:idx]
		slotRaw := value[idx+1:]
		slot, err := strconv.Atoi(slotRaw)
		if err == nil && slot > 0 {
			return id, slot
		}
	}
	return value, fallbackSlot
}
func newModel(session string, members []member) model {
	vp := viewport.New(80, 20)
	vp.MouseWheelEnabled = true
	// Strip every viewport binding that collides with the dashboard's own
	// keymap. Space toggles agent marking; u/d/b/f/h/l have no scroll
	// meaning here. Up/Down/k/j only fire when the preview pane is focused
	// (the focus router decides whether to forward arrow keys).
	vp.KeyMap = viewport.KeyMap{
		Up:           key.NewBinding(key.WithKeys("up", "k")),
		Down:         key.NewBinding(key.WithKeys("down", "j")),
		PageUp:       key.NewBinding(key.WithKeys("pgup")),
		PageDown:     key.NewBinding(key.WithKeys("pgdown")),
		HalfPageUp:   key.NewBinding(key.WithKeys("ctrl+u")),
		HalfPageDown: key.NewBinding(key.WithKeys("ctrl+d")),
	}
	return model{
		session:  session,
		members:  members,
		checked:  map[string]bool{},
		viewport: vp,
		focus:    paneRoster,
		status:   "ready",
	}
}
func (m model) Init() tea.Cmd {
	return tea.Batch(refreshCmd(m), tickCmd())
}
func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.resizeViewport()
		return m, nil
	case tea.KeyMsg:
		return m.handleKey(msg)
	case tea.MouseMsg:
		if m.mode != modeNormal {
			return m, nil
		}
		var cmd tea.Cmd
		m.viewport, cmd = m.viewport.Update(msg)
		return m, cmd
	case refreshMsg:
		if msg.Err != nil {
			m.err = msg.Err.Error()
		} else {
			m.err = ""
			m.state = msg.State
			wasAtBottom := m.viewport.AtBottom()
			m.viewport.SetContent(strings.Join(msg.Preview, "\n"))
			if wasAtBottom {
				m.viewport.GotoBottom()
			}
		}
		return m, nil
	case openMsg:
		if msg.Err != nil {
			m.err = msg.Err.Error()
			return m, nil
		}
		return m, nil
	case tickMsg:
		return m, tea.Batch(refreshCmd(m), tickCmd())
	}
	return m, nil
}
func (m *model) resizeViewport() {
	width := max(80, m.width)
	height := max(24, m.height)
	bodyHeight := max(8, height-4)
	leftWidth := clamp(width/4, 32, 42)
	rightWidth := max(30, width-leftWidth-1)
	// -4 = 2 border verticals + 2 padding columns (matches panel()).
	m.viewport.Width = max(1, rightWidth-4)
	m.viewport.Height = max(1, bodyHeight-2)
}
func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch m.mode {
	case modeQuickOpen:
		return m.handleQuickOpenKey(msg)
	case modePrompt:
		return m.handlePromptKey(msg)
	case modeRawInsert:
		return m.handleRawInsertKey(msg)
	case modeCommandPalette:
		return m.handleCommandPaletteKey(msg)
	case modeHelp:
		return m.handleHelpKey(msg)
	default:
		return m.handleNormalKey(msg)
	}
}
func (m model) handleNormalKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	keyStr := msg.String()
	// Focus-independent action keys. These act on the selected agent or the
	// dashboard as a whole regardless of which pane has focus.
	switch keyStr {
	case "ctrl+c", "x":
		return m, tea.Quit
	case "tab", "shift+tab":
		m.focus = m.focus.toggle()
		return m, nil
	case "[":
		m.focus = paneRoster
		return m, nil
	case "]":
		m.focus = panePreview
		return m, nil
	case "?":
		m.mode = modeHelp
		return m, nil
	case ":":
		m.mode = modeCommandPalette
		m.paletteQuery = ""
		m.paletteIndex = 0
		return m, nil
	case "!":
		m.showAttention = !m.showAttention
		return m, nil
	case "enter":
		if selected, ok := m.selectedMember(); ok {
			return m, openAgentCmd(m.session, selected)
		}
		return m, nil
	case "q":
		m.mode = modeQuickOpen
		m.quickQuery = ""
		return m, nil
	case " ":
		if selected, ok := m.selectedMember(); ok {
			m.checked[selected.ID] = !m.checked[selected.ID]
		}
		return m, nil
	case "i":
		if selected, ok := m.selectedMember(); ok {
			m.beginRawInsert([]member{selected}, "", false)
		}
		return m, nil
	case "o":
		if selected, ok := m.selectedMember(); ok {
			m.beginRawInsert([]member{selected}, "", true)
		}
		return m, nil
	case "I":
		targets := m.checkedMembers()
		if len(targets) == 0 {
			m.status = "mark agents with space before multi-raw insert"
			return m, nil
		}
		m.beginRawInsert(targets, "", false)
		return m, nil
	case "O":
		targets := m.checkedMembers()
		if len(targets) == 0 {
			m.status = "mark agents with space before multi-raw insert"
			return m, nil
		}
		m.beginRawInsert(targets, "", true)
		return m, nil
	case "/":
		if selected, ok := m.selectedMember(); ok {
			m.beginRawInsert([]member{selected}, "/", false)
		}
		return m, nil
	case "@":
		if selected, ok := m.selectedMember(); ok {
			m.beginRawInsert([]member{selected}, "@", false)
		}
		return m, nil
	case "m":
		if selected, ok := m.selectedMember(); ok {
			m.beginPrompt("message "+selected.ID, "message", []string{selected.ID})
		}
		return m, nil
	case "a":
		if selected, ok := m.selectedMember(); ok {
			m.beginPrompt("ask "+selected.ID, "ask", []string{selected.ID})
		}
		return m, nil
	case "g":
		targets := checkedTargets(m.checked)
		if len(targets) == 0 {
			m.status = "mark agents with space before group send"
			return m, nil
		}
		m.beginPrompt("message "+strings.Join(targets, ","), "message", targets)
		return m, nil
	case "b":
		m.beginPrompt("broadcast message", "message", nil)
		return m, nil
	case "r":
		m.status = "refreshed"
		return m, refreshCmd(m)
	case "c":
		return m, runDetachedCmd("tmux", "choose-tree", "-w")
	}
	if len(keyStr) == 1 && keyStr >= "1" && keyStr <= "9" {
		slot, _ := strconv.Atoi(keyStr)
		if item, ok := memberBySlot(m.members, slot); ok {
			return m, openAgentCmd(m.session, item)
		}
		m.status = "no agent in slot " + keyStr
		return m, nil
	}
	// Always-preview keys. Pgup/pgdn/ctrl+u/d/ctrl+home/end have no roster
	// meaning, so they always scroll the preview regardless of focus.
	switch keyStr {
	case "pgup", "pgdown", "ctrl+u", "ctrl+d":
		var cmd tea.Cmd
		m.viewport, cmd = m.viewport.Update(msg)
		return m, cmd
	case "ctrl+home":
		m.viewport.GotoTop()
		return m, nil
	case "ctrl+end":
		m.viewport.GotoBottom()
		return m, nil
	}
	// Focus-aware navigation keys. Arrow keys + home/end target the
	// focused pane: roster moves selection, preview scrolls content.
	switch keyStr {
	case "up", "k":
		if m.focus == panePreview {
			var cmd tea.Cmd
			m.viewport, cmd = m.viewport.Update(msg)
			return m, cmd
		}
		return m.moveSelection(-1)
	case "down", "j":
		if m.focus == panePreview {
			var cmd tea.Cmd
			m.viewport, cmd = m.viewport.Update(msg)
			return m, cmd
		}
		return m.moveSelection(+1)
	case "home":
		if m.focus == panePreview {
			m.viewport.GotoTop()
			return m, nil
		}
		if m.selected == 0 {
			return m, nil
		}
		m.selected = 0
		m.rosterScroll = 0
		m.viewport.GotoBottom()
		return m, refreshCmd(m)
	case "end":
		if m.focus == panePreview {
			m.viewport.GotoBottom()
			return m, nil
		}
		last := len(m.members) - 1
		if m.selected == last {
			return m, nil
		}
		m.selected = last
		m.rosterScroll = m.ensureSelectedVisible()
		m.viewport.GotoBottom()
		return m, refreshCmd(m)
	}
	return m, nil
}
func (m model) moveSelection(delta int) (tea.Model, tea.Cmd) {
	prev := m.selected
	m.selected = clamp(m.selected+delta, 0, len(m.members)-1)
	if m.selected == prev {
		return m, nil
	}
	m.rosterScroll = m.ensureSelectedVisible()
	m.viewport.GotoBottom()
	return m, refreshCmd(m)
}
func (m model) handleQuickOpenKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	switch key {
	case "esc", "ctrl+c":
		m.mode = modeNormal
		m.quickQuery = ""
		return m, nil
	case "enter":
		match, ok := firstQuickMatch(m.members, m.quickQuery)
		m.mode = modeNormal
		m.quickQuery = ""
		if !ok {
			return m, nil
		}
		return m, openAgentCmd(m.session, match)
	case "backspace":
		if len(m.quickQuery) > 0 {
			_, size := utf8.DecodeLastRuneInString(m.quickQuery)
			m.quickQuery = m.quickQuery[:len(m.quickQuery)-size]
		}
		return m, nil
	default:
		if len(key) == 1 && key >= " " {
			m.quickQuery += key
		}
		return m, nil
	}
}
func (m model) handlePromptKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	switch key {
	case "esc", "ctrl+c":
		m.mode = modeNormal
		m.input = ""
		m.promptTitle = ""
		m.promptAction = ""
		m.promptTargets = nil
		return m, nil
	case "enter":
		body := strings.TrimSpace(m.input)
		action := m.promptAction
		targets := append([]string(nil), m.promptTargets...)
		m.mode = modeNormal
		m.input = ""
		m.promptTitle = ""
		m.promptAction = ""
		m.promptTargets = nil
		if body == "" || action == "" {
			return m, nil
		}
		return m, sendA2ACmd(action, targets, body)
	case "backspace":
		if len(m.input) > 0 {
			_, size := utf8.DecodeLastRuneInString(m.input)
			m.input = m.input[:len(m.input)-size]
		}
		return m, nil
	default:
		if len(key) == 1 && key >= " " {
			m.input += key
		}
		return m, nil
	}
}
func (m *model) beginPrompt(title string, action string, targets []string) {
	m.mode = modePrompt
	m.promptTitle = title
	m.promptAction = action
	m.promptTargets = targets
	m.input = ""
}
func (m *model) beginRawInsert(targets []member, prefix string, openAfter bool) {
	m.mode = modeRawInsert
	m.rawTargets = append([]member(nil), targets...)
	m.rawInput = prefix
	m.rawOpenAfter = openAfter
}
func (m model) handleRawInsertKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	switch key {
	case "esc", "ctrl+c":
		m.mode = modeNormal
		m.rawTargets = nil
		m.rawInput = ""
		m.rawOpenAfter = false
		return m, nil
	case "enter":
		body := strings.TrimSpace(m.rawInput)
		targets := append([]member(nil), m.rawTargets...)
		openAfter := m.rawOpenAfter
		m.mode = modeNormal
		m.rawTargets = nil
		m.rawInput = ""
		m.rawOpenAfter = false
		if body == "" || len(targets) == 0 {
			return m, nil
		}
		m.status = fmt.Sprintf("sent raw input to %s", memberListLabel(targets))
		return m, sendRawInputCmd(targets, body, openAfter)
	case "backspace":
		if len(m.rawInput) > 0 {
			_, size := utf8.DecodeLastRuneInString(m.rawInput)
			m.rawInput = m.rawInput[:len(m.rawInput)-size]
		}
		return m, nil
	default:
		if len(key) == 1 && key >= " " {
			m.rawInput += key
		}
		return m, nil
	}
}
func (m model) handleHelpKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "ctrl+c", "?", "enter":
		m.mode = modeNormal
		return m, nil
	case "x":
		return m, tea.Quit
	case ":":
		m.mode = modeCommandPalette
		m.paletteQuery = ""
		m.paletteIndex = 0
		return m, nil
	default:
		return m, nil
	}
}
func (m model) handleCommandPaletteKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	matches := commandPaletteMatches(m.paletteQuery)
	switch key {
	case "esc", "ctrl+c":
		m.mode = modeNormal
		m.paletteQuery = ""
		m.paletteIndex = 0
		return m, nil
	case "up", "k":
		m.paletteIndex = clamp(m.paletteIndex-1, 0, max(0, len(matches)-1))
		return m, nil
	case "down", "j":
		m.paletteIndex = clamp(m.paletteIndex+1, 0, max(0, len(matches)-1))
		return m, nil
	case "enter":
		if len(matches) == 0 {
			return m, nil
		}
		command := matches[clamp(m.paletteIndex, 0, len(matches)-1)]
		m.mode = modeNormal
		m.paletteQuery = ""
		m.paletteIndex = 0
		return m.executeDashboardCommand(command.ID)
	case "backspace":
		if len(m.paletteQuery) > 0 {
			_, size := utf8.DecodeLastRuneInString(m.paletteQuery)
			m.paletteQuery = m.paletteQuery[:len(m.paletteQuery)-size]
			m.paletteIndex = 0
		}
		return m, nil
	default:
		if len(key) == 1 && key >= " " {
			m.paletteQuery += key
			m.paletteIndex = 0
		}
		return m, nil
	}
}
func (m model) executeDashboardCommand(id commandID) (tea.Model, tea.Cmd) {
	selected, hasSelected := m.selectedMember()
	switch id {
	case commandOpenSelected:
		if hasSelected {
			return m, openAgentCmd(m.session, selected)
		}
	case commandSlotHelp:
		m.status = "press 1-9 to open a numbered agent slot"
		return m, nil
	case commandQuickOpen:
		m.mode = modeQuickOpen
		m.quickQuery = ""
		return m, nil
	case commandMessage:
		if hasSelected {
			m.beginPrompt("message "+selected.ID, "message", []string{selected.ID})
		}
		return m, nil
	case commandAsk:
		if hasSelected {
			m.beginPrompt("ask "+selected.ID, "ask", []string{selected.ID})
		}
		return m, nil
	case commandRawInsert:
		if hasSelected {
			m.beginRawInsert([]member{selected}, "", false)
		}
		return m, nil
	case commandRawOpen:
		if hasSelected {
			m.beginRawInsert([]member{selected}, "", true)
		}
		return m, nil
	case commandRawMulti:
		targets := m.checkedMembers()
		if len(targets) == 0 {
			m.status = "mark agents with space before multi-raw insert"
			return m, nil
		}
		m.beginRawInsert(targets, "", false)
		return m, nil
	case commandRawMultiOpen:
		targets := m.checkedMembers()
		if len(targets) == 0 {
			m.status = "mark agents with space before multi-raw insert"
			return m, nil
		}
		m.beginRawInsert(targets, "", true)
		return m, nil
	case commandSlash:
		if hasSelected {
			m.beginRawInsert([]member{selected}, "/", false)
		}
		return m, nil
	case commandMention:
		if hasSelected {
			m.beginRawInsert([]member{selected}, "@", false)
		}
		return m, nil
	case commandMark:
		if hasSelected {
			m.checked[selected.ID] = !m.checked[selected.ID]
		}
		return m, nil
	case commandGroupMessage:
		targets := checkedTargets(m.checked)
		if len(targets) == 0 {
			m.status = "mark agents with space before group send"
			return m, nil
		}
		m.beginPrompt("message "+strings.Join(targets, ","), "message", targets)
		return m, nil
	case commandBroadcast:
		m.beginPrompt("broadcast message", "message", nil)
		return m, nil
	case commandRefresh:
		m.status = "refreshed"
		return m, refreshCmd(m)
	case commandChooser:
		return m, runDetachedCmd("tmux", "choose-tree", "-w")
	case commandToggleFocus:
		m.focus = m.focus.toggle()
		return m, nil
	case commandFocusRoster:
		m.focus = paneRoster
		return m, nil
	case commandFocusPreview:
		m.focus = panePreview
		return m, nil
	case commandAttention:
		m.showAttention = !m.showAttention
		return m, nil
	case commandHelp:
		m.mode = modeHelp
		return m, nil
	case commandPalette:
		m.mode = modeCommandPalette
		m.paletteQuery = ""
		m.paletteIndex = 0
		return m, nil
	case commandQuit:
		return m, tea.Quit
	}
	return m, nil
}
func (m model) checkedMembers() []member {
	out := []member{}
	for _, item := range m.members {
		if m.checked[item.ID] {
			out = append(out, item)
		}
	}
	return out
}
func memberListLabel(targets []member) string {
	ids := make([]string, 0, len(targets))
	for _, target := range targets {
		ids = append(ids, target.ID)
	}
	return strings.Join(ids, ",")
}
func sendRawInputCmd(targets []member, body string, openAfter bool) tea.Cmd {
	return func() tea.Msg {
		args := []string{"raw"}
		if openAfter {
			args = append(args, "--open")
		}
		for _, target := range targets {
			args = append(args, "--to", target.ID)
		}
		args = append(args, "--content", body)
		cmd := exec.Command("a2a", args...)
		cmd.Env = append(os.Environ(), "A2A_OPERATOR_SOURCE=cli")
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			return openMsg{Err: fmt.Errorf("raw input failed: %s", firstNonEmpty(stderr.String(), err.Error()))}
		}
		return openMsg{}
	}
}
func (m model) View() string {
	width := max(80, m.width)
	height := max(24, m.height)
	headerHeight := 2
	footerHeight := 2
	bodyHeight := max(8, height-headerHeight-footerHeight)
	leftWidth := clamp(width/4, 32, 42)
	rightWidth := max(30, width-leftWidth-1)
	header := m.renderHeader(width)
	footer := m.renderFooter(width)
	left := m.renderRoster(leftWidth, bodyHeight)
	right := m.renderRightPane(rightWidth, bodyHeight)
	body := joinColumns(left, right, " ")
	return header + "\n" + body + "\n" + footer
}
func (m model) renderHeader(width int) string {
	bridge := okStyle.Render("bridge ok")
	if m.state.BridgeError != "" {
		bridge = errorStyle.Render(m.state.BridgeError)
	}
	if m.err != "" {
		bridge = errorStyle.Render(m.err)
	}
	selected := ""
	if member, ok := m.selectedMember(); ok {
		selected = fmt.Sprintf(" selected %s#%d", member.ID, member.Slot)
	}
	attention := ""
	if len(m.state.Attention) > 0 {
		attention = " " + warnStyle.Render(fmt.Sprintf("!%d attention", len(m.state.Attention)))
	}
	line := fmt.Sprintf(
		" %s %s%s%s %s",
		titleStyle.Render("a2a command center"),
		mutedStyle.Render(m.session),
		mutedStyle.Render(selected),
		attention,
		bridge,
	)
	return clip(line, width) + "\n" + borderStyle.Render(strings.Repeat("─", width))
}
func (m model) renderRoster(width int, height int) string {
	innerHeight := max(1, height-2)
	members := m.visibleMembers(innerHeight)
	rows := make([]string, 0, innerHeight)
	registered := map[string]registeredAgent{}
	for _, agent := range m.state.Registered {
		registered[agent.key()] = agent
	}
	for _, item := range members {
		row := m.renderRosterRow(item.Index, item.Member, registered)
		if item.Index == m.selected {
			row = activeStyle.Render(clipPlain(row, width-2))
		}
		rows = append(rows, row)
	}
	for len(rows) < innerHeight {
		rows = append(rows, "")
	}
	title := fmt.Sprintf("Agents %d-%d/%d", m.rosterScroll+1, min(len(m.members), m.rosterScroll+innerHeight), len(m.members))
	return panel(width, height, title, rows, m.focus == paneRoster)
}

type visibleMember struct {
	Index  int
	Member member
}

func (m model) visibleMembers(limit int) []visibleMember {
	start := clamp(m.rosterScroll, 0, max(0, len(m.members)-1))
	end := min(len(m.members), start+limit)
	out := make([]visibleMember, 0, end-start)
	for i := start; i < end; i++ {
		out = append(out, visibleMember{Index: i, Member: m.members[i]})
	}
	return out
}
func (m model) renderRosterRow(index int, item member, registered map[string]registeredAgent) string {
	checked := "○"
	if m.checked[item.ID] {
		checked = "●"
	}
	status := "unknown"
	mode := ""
	if agent, ok := registered[item.ID]; ok {
		status = agent.Status
		if agent.Yolo != nil {
			if *agent.Yolo {
				mode = "yolo"
			} else {
				mode = "safe"
			}
		}
	} else if contains(m.state.Orphans, item.ID) {
		status = "tmux-only"
	}
	return fmt.Sprintf(
		"%s #%02d %-18s %-11s %s",
		checked,
		item.Slot,
		item.ID,
		status,
		mode,
	)
}
func (m model) renderRightPane(width int, height int) string {
	if m.mode == modeHelp {
		return m.renderHelp(width, height)
	}
	if m.mode == modeCommandPalette {
		return m.renderCommandPalette(width, height)
	}
	if m.mode == modeQuickOpen {
		return m.renderQuickOpen(width, height)
	}
	if m.showAttention {
		return m.renderAttention(width, height)
	}
	return m.renderPreview(width, height)
}
func (m model) renderHelp(width int, height int) string {
	rows := commandHelpLines(height - 2)
	return panel(width, height, "Dashboard Help", rows, true)
}
func (m model) renderCommandPalette(width int, height int) string {
	rows := commandPaletteLines(m.paletteQuery, m.paletteIndex, height-2)
	return panel(width, height, "Command Palette", rows, true)
}
func (m model) renderQuickOpen(width int, height int) string {
	rows := quickMatchLines(m.members, m.quickQuery, height-2)
	return panel(width, height, "Open Agent By Name", rows, m.focus == panePreview)
}
func (m model) renderAttention(width int, height int) string {
	rows := attentionLines(m.state.Attention, height-2)
	return panel(width, height, "Attention", rows, m.focus == panePreview)
}
func (m model) renderPreview(width int, height int) string {
	innerHeight := max(1, height-2)
	rows := strings.Split(m.viewport.View(), "\n")
	for len(rows) < innerHeight {
		rows = append(rows, "")
	}
	title := "Preview none"
	if selected, ok := m.selectedMember(); ok {
		title = fmt.Sprintf("Preview %s - slot %d - %d%%", selected.ID, selected.Slot, int(m.viewport.ScrollPercent()*100))
	}
	return panel(width, height, title, rows, m.focus == panePreview)
}
func (m model) renderFooter(width int) string {
	if m.mode == modeQuickOpen {
		line1 := " open agent by name: " + m.quickQuery
		line2 := mutedStyle.Render(" type name filter · enter opens first match · esc cancel")
		return clip(line1, width) + "\n" + clip(line2, width)
	}
	if m.mode == modePrompt {
		line1 := fmt.Sprintf(" %s: %s", m.promptTitle, m.input)
		line2 := mutedStyle.Render(" enter submit · esc cancel")
		return clip(line1, width) + "\n" + clip(line2, width)
	}
	if m.mode == modeRawInsert {
		line1 := fmt.Sprintf(" raw insert to %s: %s", memberListLabel(m.rawTargets), m.rawInput)
		line2 := mutedStyle.Render(" type anything · enter pastes into real pane · esc cancel")
		return clip(line1, width) + "\n" + clip(line2, width)
	}
	if m.mode == modeCommandPalette {
		line1 := " command: " + m.paletteQuery
		line2 := mutedStyle.Render(" type to filter · ↑/↓ choose · enter run · esc cancel")
		return clip(line1, width) + "\n" + clip(line2, width)
	}
	if m.mode == modeHelp {
		line1 := " dashboard help"
		line2 := mutedStyle.Render(" ?/enter/esc close · : command palette")
		return clip(line1, width) + "\n" + clip(line2, width)
	}
	focus := "roster"
	if m.focus == panePreview {
		focus = "preview"
	}
	line := fmt.Sprintf(" focus:%s · tab toggle · 1-9 open slots · Enter open · m msg · a ask · i raw · o raw+open · q find · ! attention · ? help · : commands · x quit", focus)
	if m.status != "" && m.status != "ready" {
		line = " " + m.status + " ·" + line
	}
	if len(m.state.Attention) > 0 {
		line = fmt.Sprintf(" !%d attention ·%s", len(m.state.Attention), line)
	}
	scroll := " roster: ↑/↓ home/end · preview: ↑/↓ or wheel · pgup/pgdn page · ctrl+u/ctrl+d half · ctrl+home/ctrl+end top/bottom · [/ ] focus"
	return clip(mutedStyle.Render(line), width) + "\n" + clip(mutedStyle.Render(scroll), width)
}
func (m model) selectedMember() (member, bool) {
	if m.selected < 0 || m.selected >= len(m.members) {
		return member{}, false
	}
	return m.members[m.selected], true
}
func (m model) ensureSelectedVisible() int {
	visible := max(1, m.height-4)
	scroll := m.rosterScroll
	if m.selected < scroll {
		scroll = m.selected
	}
	if m.selected >= scroll+visible {
		scroll = m.selected - visible + 1
	}
	return clamp(scroll, 0, max(0, len(m.members)-visible))
}

type tickMsg struct{}

func tickCmd() tea.Cmd {
	return tea.Tick(5*time.Second, func(time.Time) tea.Msg {
		return tickMsg{}
	})
}
func refreshCmd(m model) tea.Cmd {
	selected, _ := m.selectedMember()
	return func() tea.Msg {
		state, err := readA2AState()
		if err != nil {
			return refreshMsg{Err: err}
		}
		preview := []string{}
		if selected.ID != "" {
			preview = captureAgent(selected.ID, 500)
		}
		return refreshMsg{
			State:   state,
			Preview: preview,
		}
	}
}
func readA2AState() (listState, error) {
	result := run("a2a", "list", "--json", "--no-peers")
	if result.Err != nil {
		return listState{BridgeError: result.Stderr}, nil
	}
	var state listState
	if err := json.Unmarshal([]byte(result.Stdout), &state); err != nil {
		return listState{}, fmt.Errorf("a2a list returned invalid JSON: %w", err)
	}
	attentionResult := run("a2a", "attention", "--json", "--no-peers")
	if attentionResult.Err == nil {
		if err := json.Unmarshal([]byte(attentionResult.Stdout), &state.Attention); err != nil {
			state.Attention = []attentionItem{{
				Kind:     "attention-error",
				ID:       "attention",
				Severity: "warn",
				Message:  "a2a attention returned invalid JSON",
			}}
		}
	} else {
		state.Attention = []attentionItem{{
			Kind:     "attention-error",
			ID:       "attention",
			Severity: "warn",
			Message:  firstNonEmpty(attentionResult.Stderr, attentionResult.Err.Error()),
		}}
	}
	return state, nil
}
func captureAgent(agentID string, lines int) []string {
	result := run("tmux", "capture-pane", "-t", agentID+":0.0", "-p", "-S", fmt.Sprintf("-%d", lines))
	if result.Err != nil {
		return []string{"capture failed: " + firstNonEmpty(result.Stderr, result.Err.Error())}
	}
	raw := strings.Split(result.Stdout, "\n")
	out := make([]string, 0, len(raw))
	for _, line := range raw {
		cleaned := cleanPreviewLine(line)
		if strings.TrimSpace(cleaned) != "" {
			out = append(out, cleaned)
		}
	}
	return out
}
func openAgentCmd(session string, item member) tea.Cmd {
	return func() tea.Msg {
		target, err := resolveViewWindowTarget(session, item)
		if err != nil {
			return openMsg{Err: err}
		}
		if os.Getenv("TMUX") != "" {
			if result := run("tmux", "switch-client", "-t", target); result.Err == nil {
				return openMsg{}
			}
		}
		if result := run("tmux", "select-window", "-t", target); result.Err != nil {
			return openMsg{Err: fmt.Errorf("open %s failed: %s", target, firstNonEmpty(result.Stderr, result.Err.Error()))}
		}
		return openMsg{}
	}
}
func resolveViewWindowTarget(session string, item member) (string, error) {
	wid, err := agentWindowID(item.ID)
	if err == nil && wid != "" {
		if index, ok := viewWindowIndexByWindowID(session, wid); ok {
			return session + ":" + index, nil
		}
		if result := run("tmux", "link-window", "-d", "-s", item.ID+":0", "-t", session+":"); result.Err != nil {
			return "", fmt.Errorf("relink %s failed: %s", item.ID, firstNonEmpty(result.Stderr, result.Err.Error()))
		}
		if index, ok := viewWindowIndexByWindowID(session, wid); ok {
			return session + ":" + index, nil
		}
		return "", fmt.Errorf("relinked %s but could not resolve window index", item.ID)
	}
	if index, ok := viewWindowIndexForMember(session, item); ok {
		return session + ":" + index, nil
	}
	return "", fmt.Errorf("cannot open %s: source window unavailable", item.ID)
}
func agentWindowID(agentID string) (string, error) {
	result := run("tmux", "display-message", "-p", "-t", agentID+":0", "#{window_id}")
	if result.Err != nil {
		return "", result.Err
	}
	return strings.TrimSpace(result.Stdout), nil
}

type viewWindow struct {
	ID    string
	Index string
	Name  string
}

func viewWindows(session string) []viewWindow {
	result := run("tmux", "list-windows", "-t", session, "-F", "#{window_id}\t#{window_index}\t#{window_name}")
	if result.Err != nil {
		return nil
	}
	lines := strings.Split(result.Stdout, "\n")
	out := make([]viewWindow, 0, len(lines))
	for _, line := range lines {
		parts := strings.Split(line, "\t")
		if len(parts) < 2 {
			continue
		}
		window := viewWindow{
			ID:    strings.TrimSpace(parts[0]),
			Index: strings.TrimSpace(parts[1]),
		}
		if len(parts) >= 3 {
			window.Name = strings.TrimSpace(parts[2])
		}
		if window.ID != "" && window.Index != "" {
			out = append(out, window)
		}
	}
	return out
}
func viewWindowIndexByWindowID(session string, wid string) (string, bool) {
	for _, window := range viewWindows(session) {
		if window.ID == wid {
			return window.Index, true
		}
	}
	return "", false
}
func viewWindowIndexForMember(session string, item member) (string, bool) {
	slot := strconv.Itoa(item.Slot)
	for _, window := range viewWindows(session) {
		if window.Name == item.ID {
			return window.Index, true
		}
	}
	for _, window := range viewWindows(session) {
		if window.Index == slot {
			return window.Index, true
		}
	}
	return "", false
}
func sendA2ACmd(action string, targets []string, body string) tea.Cmd {
	return func() tea.Msg {
		args := []string{"--from", "user"}
		if action == "ask" {
			args = append(args, "--ask")
		} else {
			args = append(args, "--message")
		}
		for _, target := range targets {
			args = append(args, "--"+target)
		}
		args = append(args, body)
		cmd := exec.Command("a2a", args...)
		cmd.Env = append(os.Environ(), "A2A_OPERATOR_SOURCE=cli")
		var stdout bytes.Buffer
		var stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			return openMsg{Err: fmt.Errorf("send failed: %s", firstNonEmpty(stderr.String(), err.Error()))}
		}
		return openMsg{}
	}
}
func runDetachedCmd(name string, args ...string) tea.Cmd {
	return func() tea.Msg {
		result := run(name, args...)
		if result.Err != nil {
			return openMsg{Err: fmt.Errorf("%s failed: %s", name, firstNonEmpty(result.Stderr, result.Err.Error()))}
		}
		return openMsg{}
	}
}

type runResult struct {
	Stdout string
	Stderr string
	Err    error
}

func run(name string, args ...string) runResult {
	cmd := exec.Command(name, args...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return runResult{
		Stdout: stdout.String(),
		Stderr: strings.TrimSpace(stderr.String()),
		Err:    err,
	}
}
func panel(width int, height int, title string, rows []string, focused bool) string {
	width = max(6, width)
	height = max(3, height)
	inner := width - 2        // between the two border verticals
	padded := max(0, inner-2) // after 1-char horizontal padding on each side
	bodyHeight := height - 2
	border := borderStyle
	titleColor := titleStyle
	if focused {
		border = focusedBorderStyle
		titleColor = titleStyle.Foreground(lipgloss.Color("51"))
	}
	title = " " + title + " "
	if runeLen(title) > inner {
		title = truncate(title, inner)
	}
	left := max(0, (inner-runeLen(title))/2)
	right := max(0, inner-runeLen(title)-left)
	lines := []string{
		border.Render("┌"+strings.Repeat("─", left)) + titleColor.Render(title) + border.Render(strings.Repeat("─", right)+"┐"),
	}
	for i := 0; i < bodyHeight; i++ {
		row := ""
		if i < len(rows) {
			row = rows[i]
		}
		lines = append(lines, border.Render("│")+" "+clipPlain(row, padded)+" "+border.Render("│"))
	}
	lines = append(lines, border.Render("└"+strings.Repeat("─", inner)+"┘"))
	return strings.Join(lines, "\n")
}
func joinColumns(left string, right string, gap string) string {
	leftLines := strings.Split(left, "\n")
	rightLines := strings.Split(right, "\n")
	height := max(len(leftLines), len(rightLines))
	leftWidth := maxLineWidth(leftLines)
	out := make([]string, 0, height)
	for i := 0; i < height; i++ {
		l := ""
		if i < len(leftLines) {
			l = leftLines[i]
		}
		r := ""
		if i < len(rightLines) {
			r = rightLines[i]
		}
		out = append(out, l+strings.Repeat(" ", max(0, leftWidth-visibleWidth(l)))+gap+r)
	}
	return strings.Join(out, "\n")
}
func cleanPreviewLine(value string) string {
	line := stripANSI(value)
	line = strings.ReplaceAll(line, "\r", " ")
	line = strings.ReplaceAll(line, "\t", " ")
	line = strings.TrimRight(line, " ")
	return line
}
func stripANSI(value string) string {
	out := strings.Builder{}
	escaped := false
	csi := false
	for _, r := range value {
		if escaped {
			if r == '[' {
				csi = true
			} else {
				escaped = false
			}
			continue
		}
		if csi {
			if r >= '@' && r <= '~' {
				csi = false
				escaped = false
			}
			continue
		}
		if r == '\x1b' {
			escaped = true
			continue
		}
		out.WriteRune(r)
	}
	return out.String()
}
func checkedTargets(checked map[string]bool) []string {
	out := []string{}
	for id, ok := range checked {
		if ok {
			out = append(out, id)
		}
	}
	return out
}
func firstQuickMatch(members []member, query string) (member, bool) {
	query = strings.ToLower(strings.TrimSpace(query))
	for _, item := range members {
		if query == "" || strings.Contains(strings.ToLower(item.ID), query) {
			return item, true
		}
	}
	return member{}, false
}
func memberBySlot(members []member, slot int) (member, bool) {
	for _, item := range members {
		if item.Slot == slot {
			return item, true
		}
	}
	return member{}, false
}
func quickMatchLines(members []member, query string, limit int) []string {
	query = strings.ToLower(strings.TrimSpace(query))
	out := []string{}
	for _, item := range members {
		if query != "" && !strings.Contains(strings.ToLower(item.ID), query) {
			continue
		}
		out = append(out, fmt.Sprintf("%d. %s  slot %d", len(out)+1, item.ID, item.Slot))
		if len(out) >= limit {
			break
		}
	}
	if len(out) == 0 {
		return []string{"no matching agents"}
	}
	return out
}
func commandHelpLines(limit int) []string {
	if limit <= 0 {
		return []string{}
	}
	out := make([]string, 0, len(dashboardCommands))
	for _, command := range dashboardCommands {
		out = append(out, fmt.Sprintf("%-7s %-24s %s", command.Key, command.Name, command.Description))
		if len(out) >= limit {
			break
		}
	}
	if len(out) == 0 {
		return []string{"no commands"}
	}
	return out
}
func commandPaletteMatches(query string) []dashboardCommand {
	query = strings.ToLower(strings.TrimSpace(query))
	out := []dashboardCommand{}
	for _, command := range dashboardCommands {
		primary := strings.ToLower(command.Key + " " + command.Name)
		if query == "" || strings.Contains(primary, query) {
			out = append(out, command)
		}
	}
	if query == "" {
		return out
	}
	seen := map[commandID]bool{}
	for _, command := range out {
		seen[command.ID] = true
	}
	for _, command := range dashboardCommands {
		if seen[command.ID] {
			continue
		}
		description := strings.ToLower(command.Description)
		if strings.Contains(description, query) {
			out = append(out, command)
		}
	}
	return out
}
func commandPaletteLines(query string, selected int, limit int) []string {
	if limit <= 0 {
		return []string{}
	}
	matches := commandPaletteMatches(query)
	if len(matches) == 0 {
		return []string{"no matching commands"}
	}
	selected = clamp(selected, 0, len(matches)-1)
	out := make([]string, 0, min(limit, len(matches)))
	for i, command := range matches {
		marker := " "
		if i == selected {
			marker = ">"
		}
		out = append(out, fmt.Sprintf("%s %-7s %-24s %s", marker, command.Key, command.Name, command.Description))
		if len(out) >= limit {
			break
		}
	}
	return out
}
func attentionLines(attention []attentionItem, limit int) []string {
	if limit <= 0 {
		return []string{}
	}
	if len(attention) == 0 {
		return []string{"attention clear"}
	}
	out := make([]string, 0, min(limit, len(attention)))
	for i, item := range attention {
		index := item.Index
		if index == 0 {
			index = i + 1
		}
		severity := firstNonEmpty(item.Severity, "warn")
		out = append(out, fmt.Sprintf("#%-2d %-5s %-16s %-18s %s", index, severity, item.Kind, item.ID, item.Message))
		if len(out) >= limit {
			break
		}
	}
	return out
}
func contains(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
func clip(value string, width int) string {
	return clipPlain(stripANSI(value), width)
}
func clipPlain(value string, width int) string {
	if width <= 0 {
		return ""
	}
	value = stripANSI(value)
	if runeLen(value) <= width {
		return value + strings.Repeat(" ", width-runeLen(value))
	}
	return truncate(value, width)
}
func truncate(value string, width int) string {
	if width <= 0 {
		return ""
	}
	if width == 1 {
		return "…"
	}
	runes := []rune(value)
	if len(runes) <= width {
		return value
	}
	return string(runes[:width-1]) + "…"
}
func visibleWidth(value string) int {
	return runeLen(stripANSI(value))
}
func maxLineWidth(lines []string) int {
	out := 0
	for _, line := range lines {
		out = max(out, visibleWidth(line))
	}
	return out
}
func runeLen(value string) int {
	return utf8.RuneCountInString(stripANSI(value))
}
func clamp(value int, minValue int, maxValue int) int {
	if maxValue < minValue {
		return minValue
	}
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}
func min(a int, b int) int {
	if a < b {
		return a
	}
	return b
}
func max(a int, b int) int {
	if a > b {
		return a
	}
	return b
}

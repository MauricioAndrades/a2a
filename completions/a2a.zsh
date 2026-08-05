#compdef a2a
# zsh completion for a2a
# install (one-shot):  source <(a2a completion zsh)
# install (permanent): a2a completion zsh > ${fpath[1]}/_a2a
#                      then restart zsh or run: compinit

__a2a_agents() {
  local -a ids
  ids=("${(@f)$(a2a list --json --no-peers 2>/dev/null | sed -n 's/.*"agentId":"\([^"]*\)".*/\1/p')}")
  if (( ${#ids} )); then
    _describe -t agents 'agent' ids
  fi
}

__a2a_agent_flags() {
  local -a ids flags
  ids=("${(@f)$(a2a list --json --no-peers 2>/dev/null | sed -n 's/.*"agentId":"\([^"]*\)".*/\1/p')}")
  flags=()
  local id
  for id in $ids; do
    flags+=("--$id:message agent $id")
  done
  if (( ${#flags} )); then
    _describe -t agent-flags 'agent flag' flags
  fi
}

_a2a() {
  local context state line
  typeset -A opt_args

  local -a commands
  commands=(
    'bridge:start/stop/status the local bridge'
    'raw:paste literal text into an agent pane'
    'command:send a key/text sequence DSL into an agent pane'
    'say:send a message envelope'
    'ask:send an ask envelope'
    'reply:reply to the last envelope'
    'start:start an agent, group, or team'
    'start-global:legacy alias for `start --global`'
    'kill:kill agents'
    'reconnect:reconnect orphaned sessions'
    'ui:open the dashboard'
    'attach:attach to an agent session'
    'peek:show last lines of an agent pane'
    'log:tail the envelope log'
    'status:show local runtime status'
    'events:show runtime events projected from status'
    'attention:show the runtime attention queue'
    'doctor:write diagnostics or a support bundle'
    'reload:plan or apply safe team additions'
    'layout:validate a team layout tree'
    'iterm:open an attach command in iTerm2'
    'pm:generate a PM/worker team spec'
    'list:list agents and views'
    'auth:manage peer auth tokens'
    'config:get/set repo-local config'
    'gen-key:generate a new operator key'
    'register:register an external session'
    'unregister:unregister an agent'
    'completion:print a shell completion script (bash|zsh)'
    'help:show usage'
  )

  _arguments -C \
    '1:command:->cmd' \
    '*::arg:->args'

  case $state in
    cmd)
      _describe -t commands 'a2a command' commands
      ;;
    args)
      case $words[1] in
        bridge)
          _arguments \
            '1:subcommand:(start stop status iterm all)' \
            '2:action:(start stop status restart foreground)'
          ;;
        config)
          _arguments '1:subcommand:(ls get set)' '2:key:' '3:value:'
          ;;
        auth)
          _arguments '1:subcommand:(add list revoke)' '*::rest:'
          ;;
        completion)
          _arguments '1:shell:(bash zsh)'
          ;;
        kill|attach|peek|ui|unregister|log)
          _arguments \
            '--all[apply to all owned sessions]' \
            '--rebuild[recreate the dashboard view session]' \
            '--dashboard[also build dashboard layout]' \
            '--layout[alias of --dashboard]' \
            '*::agent:__a2a_agents'
          ;;
        reconnect)
          _arguments \
            '--all[reconnect every orphan]' \
            '--dashboard[rebuild dashboard layout]' \
            '--layout[alias of --dashboard]' \
            '*::agent:__a2a_agents'
          ;;
        raw)
          _arguments \
            '--to[target agent id]:agent:__a2a_agents' \
            '--target[target agent or glob]:selector:' \
            '--content[raw body]:content:' \
            '--submit[submit after paste (default)]' \
            '--no-submit[paste without submitting]' \
            '--open[jump to first target after delivery]' \
            '*::body-or-agent:__a2a_agent_flags'
          ;;
        command)
          _arguments \
            '*--command[key/text sequence DSL step (pipe-separated)]:sequence:' \
            '--write[body substituted for \$write]:text:' \
            '--stdin[read body from stdin]' \
            '--submit[submit after paste (default)]' \
            '--no-submit[do not auto-append Enter at the tail]' \
            '--to[target agent id]:agent:__a2a_agents' \
            '--from[sender id]:agent:__a2a_agents' \
            '--origin[envelope origin]:origin:' \
            '*::agent:__a2a_agent_flags'
          ;;
        start|start-global)
          _arguments \
            '--team-file[YAML/JSON team spec]:file:_files' \
            '--cohort[cohort name]:name:' \
            '--user[user name]:name:' \
            '--prompt[inline persona text]:text:' \
            '--prompt-file[persona prompt file]:file:_files' \
            '*--skill[skill name]:skill:' \
            '--dashboard[open dashboard]' \
            '--yolo[default tools accepted (default)]' \
            '--no-yolo[disable yolo]' \
            '--global[expose bridge via ngrok]' \
            '--no-global[force local mode]' \
            '--url[remote bridge url]:url:' \
            '--port[tunnel port]:port:' \
            '--insecure[expose without operator key]' \
            '--claude[use claude backend, optionally with executable path]:claude executable:_files' \
            '--gemini[use gemini backend]' \
            '--codex[use codex backend]' \
            '--cursor-agent[use cursor-agent backend]' \
            ':agent name:'
          ;;
        say|ask|reply)
          _arguments \
            '--from[sender id]:agent:__a2a_agents' \
            '--ask[switch to ask form]' \
            '--reply[switch to reply form]' \
            '--message[switch to message form]' \
            '--write[broadcast to all]' \
            '*::target-or-body:__a2a_agent_flags'
          ;;
        list)
          _arguments \
            '--json[machine-readable output]' \
            '--no-peers[skip peer enumeration]'
          ;;
        status)
          _arguments \
            '--json[machine-readable output]' \
            '--segment[compact tmux status segment]' \
            '--peers[include configured peers]' \
            '--no-peers[local status only]'
          ;;
        events|attention)
          _arguments \
            '--json[machine-readable output]' \
            '--peers[include configured peers]' \
            '--no-peers[local status only]'
          ;;
        doctor)
          _arguments \
            '--json[machine-readable output]' \
            '--peers[include configured peers]' \
            '--no-peers[local status only]' \
            '--bundle[write doctor.json, status.json, and events.json]:dir:_directories'
          ;;
        reload)
          _arguments \
            '--dry-run[only print the reload plan]' \
            '--json[machine-readable reload plan]' \
            ':team:'
          ;;
        layout)
          _arguments \
            '--json[machine-readable layout plan]' \
            ':team:'
          ;;
        iterm)
          _arguments \
            '--print[print AppleScript instead of running osascript]' \
            '*::agent:__a2a_agents'
          ;;
        pm)
          _arguments \
            '--workers[worker count]:count:' \
            '--backend[PM backend]:backend:(claude gemini codex cursor-agent)' \
            '--worker-backend[worker backend]:backend:(claude gemini codex cursor-agent)' \
            '--write[write teams/NAME.yaml]' \
            '--start[write and start the generated team]' \
            ':team name:'
          ;;
        register)
          _arguments \
            '--target[tmux target]:target:' \
            '--description[registry description]:text:' \
            '--cwd[working directory]:dir:_directories' \
            '--backend[backend id]:backend:(claude gemini codex cursor-agent)'
          ;;
        *)
          if [[ $words[CURRENT] == --* ]]; then
            __a2a_agent_flags
          fi
          ;;
      esac
      ;;
  esac
}

_a2a "$@"

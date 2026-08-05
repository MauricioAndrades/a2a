# bash completion for a2a
# install:
#   a2a completion bash > ~/.local/share/bash-completion/completions/a2a
#   # then start a new shell. requires bash-completion (brew install bash-completion@2)
#
# one-shot (bash 4+ only; macOS bash 3.2's process-substitution + source is buggy):
#   source <(a2a completion bash)

__a2a_agent_ids() {
  a2a list --json --no-peers 2>/dev/null \
    | sed -n 's/.*"agentId":"\([^"]*\)".*/\1/p'
}

_a2a() {
  local cur prev words cword i subcmd
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  local commands="bridge raw command say ask reply start start-global kill reconnect ui attach peek log status events attention doctor reload layout iterm pm list auth config gen-key register unregister completion help"

  # Find the first non-flag word after `a2a` — that's the subcommand.
  subcmd=""
  for ((i=1; i<COMP_CWORD; i++)); do
    case "${COMP_WORDS[i]}" in
      -*) continue ;;
      *) subcmd="${COMP_WORDS[i]}"; break ;;
    esac
  done

  if [[ -z "$subcmd" ]]; then
    if [[ "$cur" == --* ]]; then
      # flag-form messaging: --<agentid>
      local ids
      ids=$(__a2a_agent_ids | sed 's/^/--/')
      COMPREPLY=( $(compgen -W "$ids --ask --reply --message --write --from --command --stdin --no-submit" -- "$cur") )
    else
      COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    fi
    return
  fi

  case "$subcmd" in
    bridge)
      if [[ "${COMP_WORDS[COMP_CWORD-1]}" == "iterm" || "${COMP_WORDS[COMP_CWORD-1]}" == "all" ]]; then
        COMPREPLY=( $(compgen -W "start stop status restart foreground" -- "$cur") )
      else
        COMPREPLY=( $(compgen -W "start stop status iterm all" -- "$cur") )
      fi
      ;;
    config)
      COMPREPLY=( $(compgen -W "ls get set" -- "$cur") )
      ;;
    auth)
      COMPREPLY=( $(compgen -W "add list revoke" -- "$cur") )
      ;;
    completion)
      COMPREPLY=( $(compgen -W "bash zsh" -- "$cur") )
      ;;
    kill|attach|peek|ui|unregister|log)
      if [[ "$cur" == --* ]]; then
        COMPREPLY=( $(compgen -W "--all --rebuild --dashboard --layout" -- "$cur") )
      else
        local ids
        ids=$(__a2a_agent_ids)
        COMPREPLY=( $(compgen -W "$ids" -- "$cur") )
      fi
      ;;
    reconnect)
      if [[ "$cur" == --* ]]; then
        COMPREPLY=( $(compgen -W "--all --dashboard --layout" -- "$cur") )
      else
        local ids
        ids=$(__a2a_agent_ids)
        COMPREPLY=( $(compgen -W "$ids" -- "$cur") )
      fi
      ;;
    raw)
      case "$prev" in
        --to|--target)
          local ids
          ids=$(__a2a_agent_ids)
          COMPREPLY=( $(compgen -W "$ids" -- "$cur") )
          return
          ;;
        --content) return ;;
      esac
      if [[ "$cur" == --* ]]; then
        local ids
        ids=$(__a2a_agent_ids | sed 's/^/--/')
        COMPREPLY=( $(compgen -W "$ids --to --target --content --submit --no-submit --open" -- "$cur") )
      fi
      ;;
    command)
      case "$prev" in
        --to)
          local ids
          ids=$(__a2a_agent_ids)
          COMPREPLY=( $(compgen -W "$ids" -- "$cur") )
          return
          ;;
        --command|--write|--from|--origin) return ;;
      esac
      if [[ "$cur" == --* ]]; then
        local ids
        ids=$(__a2a_agent_ids | sed 's/^/--/')
        COMPREPLY=( $(compgen -W "$ids --command --write --stdin --no-submit --submit --to --from --origin" -- "$cur") )
      fi
      ;;
    start|start-global)
      case "$prev" in
        --team-file|--prompt-file|--claude)
          COMPREPLY=( $(compgen -f -- "$cur") )
          return
          ;;
        --cohort|--user|--prompt|--skill|--url|--port) return ;;
      esac
      if [[ "$cur" == --claude=* ]]; then
        local prefix="${cur#--claude=}"
        COMPREPLY=( $(compgen -f -- "$prefix") )
        COMPREPLY=( "${COMPREPLY[@]/#/--claude=}" )
        return
      fi
      if [[ "$cur" == --* ]]; then
        COMPREPLY=( $(compgen -W "\
          --team-file --cohort --user --prompt --prompt-file --skill \
          --dashboard --yolo --no-yolo --global --no-global \
          --url --port --insecure \
          --claude --claude= --gemini --codex --cursor-agent" -- "$cur") )
      fi
      ;;
    say|ask|reply)
      case "$prev" in
        --from)
          local ids
          ids=$(__a2a_agent_ids)
          COMPREPLY=( $(compgen -W "$ids" -- "$cur") )
          return
          ;;
      esac
      if [[ "$cur" == --* ]]; then
        local ids
        ids=$(__a2a_agent_ids | sed 's/^/--/')
        COMPREPLY=( $(compgen -W "$ids --from --ask --reply --message --write" -- "$cur") )
      fi
      ;;
    list)
      COMPREPLY=( $(compgen -W "--json --no-peers" -- "$cur") )
      ;;
    status)
      COMPREPLY=( $(compgen -W "--json --segment --peers --no-peers" -- "$cur") )
      ;;
    events|attention)
      COMPREPLY=( $(compgen -W "--json --peers --no-peers" -- "$cur") )
      ;;
    doctor)
      if [[ "$prev" == "--bundle" ]]; then
        COMPREPLY=( $(compgen -d -- "$cur") )
      else
        COMPREPLY=( $(compgen -W "--json --peers --no-peers --bundle" -- "$cur") )
      fi
      ;;
    reload)
      COMPREPLY=( $(compgen -W "--dry-run --json" -- "$cur") )
      ;;
    layout)
      COMPREPLY=( $(compgen -W "--json" -- "$cur") )
      ;;
    iterm)
      if [[ "$cur" == --* ]]; then
        COMPREPLY=( $(compgen -W "--print" -- "$cur") )
      else
        local ids
        ids=$(__a2a_agent_ids)
        COMPREPLY=( $(compgen -W "$ids" -- "$cur") )
      fi
      ;;
    pm)
      case "$prev" in
        --workers|--backend|--worker-backend) return ;;
      esac
      COMPREPLY=( $(compgen -W "--workers --backend --worker-backend --write --start" -- "$cur") )
      ;;
    register)
      if [[ "$cur" == --* ]]; then
        COMPREPLY=( $(compgen -W "--target --description --cwd --backend" -- "$cur") )
      fi
      ;;
  esac
}

complete -F _a2a a2a

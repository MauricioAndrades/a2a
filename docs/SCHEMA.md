# a2a config schema
# ~/.claude/skills/a2a/config.json

{
  # bridge settings — user-owned, set via `a2a config`
  "port": number,          # default: 7742
  "host": string,          # default: "127.0.0.1"
  "key":  string | null,   # your bridge's auth key; null = open bridge

  # remote peers — set via `a2a auth`
  # local peers are NOT stored here; they live in the bridge's in-memory registry
  "peers": {
    "<name>": {
      "url": string,   # their ngrok URL
      "key": string    # their bridge key; sent as Authorization header when messaging them
                       # also used to validate inbound messages claiming to be from them
    }
  }
}

# registry.json — machine-written, throwaway
# ~/.claude/skills/a2a/registry.json
{
  "agents": string[],   # agent ids seen from bridge, cached for token parsing
  "groups": string[]    # group names from groups/, cached for token parsing
}

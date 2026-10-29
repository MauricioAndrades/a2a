# OpenAI tunnel-client

The local Apple Silicon bundle lives in `v0.0.16/darwin-arm64/` and is ignored by Git. Keep the bundled `cloudflared`, license, and manifest files alongside `tunnel-client`.

Pinned official release: [OpenAI tunnel-client v0.0.16](https://github.com/openai/tunnel-client/releases/tag/v0.0.16).

Archive: `tunnel-client-v0.0.16-darwin-arm64.zip`.

Verified archive SHA-256:

```text
a160820d45089b5253d8d671fe2a689bde0f73d78c135d1497a7b33f28a3ac62
```

This is a standalone executable; no system installation is required. From the repository root, inspect its options with:

```sh
./tools/tunnel-client/v0.0.16/darwin-arm64/tunnel-client --help
```

Moving the bundle does not start a tunnel or configure credentials. Store runtime keys outside this repository. See the [official configuration guide](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md) for connection options.

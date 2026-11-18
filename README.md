# github-core-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/makhlukmars53/github-core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/makhlukmars53/github-core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process: git smart HTTP (upload-pack v2 with ls-refs, receive-pack v0 with fast-forward enforcement), REST v3 (repos, branches, commits, contents, issues, labels, pull requests, merges), GraphQL v4 (the documents gh and github-mcp-server send) and MCP (Streamable HTTP, revision 2026-07-28), all from one in-memory store with the packfile and object protocol implemented in process. No git binary, no database, no outside service.

## Run it

```sh
node --experimental-strip-types main.ts
```

The forge binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`, and exits 0 when the env answers `{"done": true}`. Set `MAKEFUN_SHOP_TOKEN` to the Bearer token clients must present; `MAKEFUN_TRIAL_NOW` fixes the clock for deterministic runs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=gxm3edtt&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

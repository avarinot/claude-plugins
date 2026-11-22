# claude-plugins

A Claude Code plugin marketplace holding my personal mods, skills and agents.

## Install

Add the marketplace once, then install the plugins you want:

```
/plugin marketplace add avarinot/claude-plugins
/plugin install qa-index@avarinot
```

From a shell: `claude plugin marketplace add avarinot/claude-plugins`, then `claude plugin install qa-index@avarinot`.

## Plugins

| Plugin | Kind | What it does |
| --- | --- | --- |
| [qa-index](plugins/qa-index) | mod (hooks) | Indexes the session's questions with the gist of each answer. `/qa` opens the list, `/qa N` shows answer N in full. |

## Layout

```
.claude-plugin/marketplace.json   lists every plugin
plugins/<name>/
  .claude-plugin/plugin.json      the plugin manifest (name, version, description)
  hooks/                          mods: hooks.json and the hooks module
  skills/<skill>/SKILL.md         skills
  agents/<agent>.md               subagents
```

To add a plugin: create `plugins/<name>/` with its manifest, add an entry to `marketplace.json`, then run `claude plugin validate .`.

## License

MIT, see [LICENSE](LICENSE).

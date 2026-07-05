---
id: config-resolution
title: "Config: Resolution & Precedence"
tags: [config, precedence, ini]
source: source/syncplay/ui/ConfigurationGetter.py
related: ["[[../README]]", "[[cli-and-settings-reference]]", "[[ui-and-commands]]", "[[../quirks-and-gotchas]]"]
---

# Config: Resolution & Precedence

## Precedence order (lowest → highest)

All executed inside `ConfigurationGetter.getConfiguration()` (`ConfigurationGetter.py:493-573`):

1. **Hardcoded defaults** — the literal dict built in `__init__` (lines 23-103), also stashed as
   `_defaultConfig` for later "Reset settings" use.
2. **Global `syncplay.ini`** — located via `_getConfigurationFilePath()` (below), parsed by a
   custom `SafeConfigParserUnicode(ConfigParser)` opened with `codecs.open(path, "r",
   "utf_8_sig")` (BOM-aware UTF-8). Only keys listed in `_iniStructure` per section are read —
   see [`cli-and-settings-reference.md`](cli-and-settings-reference.md) for the schema.
3. **CLI arguments** — via `_overrideConfigWithArgs(args)`: only *truthy* values overwrite the
   config (so `--room ""` or an unset `store_true` flag does **not** override file/default
   values).
4. **GUI config-prompt overrides** — if `forceGuiPrompt` is true (**defaults to `True`!**) or no
   `file` was given, and not `--no-gui`/not a Windows console, the Basic-tab dialog
   (`GuiConfiguration`) pops up and its result is merged in, overriding CLI/ini for whatever it
   collected.
5. **Per-directory `.syncplay` file(s), walked root → leaf from the media file's directory** —
   applied **last**, so this has the highest precedence of all for any key it defines.

## Per-directory discovery ("`.htaccess`-style" walk)

`__getRelativeConfigLocations()` (lines 471-479):
```python
path = os.path.dirname(os.path.realpath(config['file']))
locations = [path]
while path != os.path.dirname(path):     # walk up to filesystem root
    path = os.path.dirname(path)
    locations.append(path)
locations.reverse()                       # root-most directory first
```
`_loadRelativeConfiguration()` then iterates **root → leaf**; for each directory, checks
`CONFIG_NAMES = [".syncplay", "syncplay.ini"]` (`.syncplay` checked first). If found (and, on
non-Windows, not literally the user's own `$HOME` global-ini directory, to avoid double-loading
`$HOME/.syncplay`), it's parsed with `createConfig=False` (never creates the file) and
immediately validated. Because directories are processed root-to-leaf and each file's values
unconditionally overwrite the running config dict, **deeper (closer-to-file) config files win
over parent-directory ones**, and all of them win over global-ini/CLI/GUI values already
applied. Matched paths are recorded in `config['loadedRelativePaths']`.

## Global ini path discovery (`_getConfigurationFilePath`, lines 368-376)

1. **Portable mode** — checks `utils.findWorkingDir()` (the install dir, or `sys._MEIPASS`/exe
   directory when frozen) for a `.syncplay`/`syncplay.ini` sitting next to the executable —
   allows a fully self-contained portable install.
2. **OS default, non-XDG** — `%APPDATA%` (Windows) or `$HOME` (else) for either config filename.
3. **XDG fallback** — `$XDG_CONFIG_HOME` (default `~/.config`, auto-created with mode `0o700`)
   on Linux/macOS, `%APPDATA%` on Windows, filename `syncplay.ini`.

## Saving (`_saveConfig`, lines 441-456)

Every key listed in `_iniStructure` is written back on every run (unless `--no-store`), only
actually rewriting the file if something changed. `%` is escaped to `%%` for `ConfigParser`
interpolation safety. **Only keys enumerated in `_iniStructure` are ever persisted** — many
config keys (`debug`, `noGui`, `file`, `playerArgs`, `resetConfig`, `clearGUIData`,
`showContactInfo`, …) are pure CLI/runtime-only flags that never round-trip through the ini file.

## Validation & type coercion

`_validateArguments()` applies bucketed coercions:

| Bucket | Behavior |
|---|---|
| `_boolean` | `"True"`/`"False"` string → Python bool |
| `_tristate` | same, plus `"None"` → `None` |
| `_serialised` | `ast.literal_eval` of a stringified list/dict; defaults to `{}` on failure |
| `_numeric` | cast to `float` — **even integer-shaped settings** like `chatMaxLines` end up as `7.0` |
| `_hexadecimal` | regex `^#[0-9a-fA-F]{6}$`, else reset to `#FFFFFF` |
| `_required` | `host`, `port`, `room`, `playerPath`, `playerClass` — custom-validated; this is also where derived values get computed (see gotcha below) |

On any `InvalidConfigValue`, `_promptForMissingArguments(e)` runs: console/`--no-gui` mode prints
the error and exits; GUI mode re-opens the config dialog with the error shown, looping
recursively until valid or the user closes the window (which calls `sys.exit()` directly).

## Validation side effects (not pure validation)

- Validating `playerPath` is also where `playerClass` gets populated, via
  `PlayerFactory().getPlayerByPath(...)` (see
  [`../players/abstraction-and-selection.md`](../players/abstraction-and-selection.md)).
- Validating `host` is also where host/port actually get split (`_splitPortAndHost`, handles
  IPv6 `[addr]:port` bracket syntax).

A reimplementation that treats "validate" and "derive" as separate steps will diverge from the
reference's field ordering — replicate the side effects at the same point in the pipeline if
byte-for-byte behavioral compatibility matters.

## Related

- [`cli-and-settings-reference.md`](cli-and-settings-reference.md) — every CLI flag and every
  config key with types/defaults.
- [`ui-and-commands.md`](ui-and-commands.md) — the GUI tabs that write into this same config
  dict, and the console/chat command dispatcher.

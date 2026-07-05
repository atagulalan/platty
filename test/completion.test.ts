// Unit tests for the completion engine and file completer (spec/config/tui-ux-plan.md Phase 3/3b).
// Run with: npx tsx test/completion.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeFilePath } from "../src/tui/completion/fileCompleter.js";
import { getCompletions, type CompletionEngineContext } from "../src/tui/completion/engine.js";
import { suggestionScrollOffset } from "../src/tui/components/SuggestionOverlay.js";
import type { UserInfo } from "../src/client/UserList.js";

function baseCtx(overrides: Partial<CompletionEngineContext> = {}): CompletionEngineContext {
  return {
    powerUserMode: false,
    playlistFiles: [],
    users: [],
    settableKeys: [],
    ...overrides,
  };
}

function user(username: string, room: string): UserInfo {
  return { username, room, file: null, ready: null, controller: false };
}

// --- fileCompleter ---

const root = mkdtempSync(join(tmpdir(), "platty-completion-test-"));
mkdirSync(join(root, "Movies"));
writeFileSync(join(root, "Movies", "foo.mkv"), "");
writeFileSync(join(root, "Movies", "foo.srt"), "");
writeFileSync(join(root, "Movies", "bar.mkv"), "");
mkdirSync(join(root, "Movies", "Extras"));
writeFileSync(join(root, "readme.txt"), "");

try {
  // No slash, no `~`: basename-only fallback is out of scope -> [].
  {
    const result = completeFilePath("foo");
    assert.deepStrictEqual(result, []);
    console.log("completion.test.ts: PASS fileCompleter returns [] for bare basename");
  }

  // Directory prefix -> lists matching entries at top level.
  {
    const result = completeFilePath(`${root}/Mo`);
    assert.deepStrictEqual(result, [`${root}/Movies/`]);
    console.log("completion.test.ts: PASS fileCompleter completes directory prefix");
  }

  // Trailing slash -> lists directory contents (dirs first, then files, both alphabetical).
  {
    const result = completeFilePath(`${root}/Movies/`);
    assert.deepStrictEqual(result, [
      `${root}/Movies/Extras/`,
      `${root}/Movies/bar.mkv`,
      `${root}/Movies/foo.mkv`,
      `${root}/Movies/foo.srt`,
    ]);
    console.log("completion.test.ts: PASS fileCompleter lists directory contents on trailing slash");
  }

  // Basename prefix filter within a directory.
  {
    const result = completeFilePath(`${root}/Movies/foo`);
    assert.deepStrictEqual(result, [`${root}/Movies/foo.mkv`, `${root}/Movies/foo.srt`]);
    console.log("completion.test.ts: PASS fileCompleter filters by basename prefix");
  }

  // Nonexistent directory -> [] (never throws).
  {
    const result = completeFilePath(`${root}/DoesNotExist/foo`);
    assert.deepStrictEqual(result, []);
    console.log("completion.test.ts: PASS fileCompleter swallows ENOENT and returns []");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// --- getCompletions: command name completion ---

{
  const result = getCompletions({ line: "/pa", cursor: 3 }, baseCtx());
  assert.ok(result.suggestions.includes("/pause"));
  assert.strictEqual(result.replaceFrom, 0);
  console.log("completion.test.ts: PASS command-name completion matches basic-tier alias");
}

{
  // Power-tier commands hidden unless powerUserMode is on.
  const basic = getCompletions({ line: "/se", cursor: 3 }, baseCtx());
  assert.ok(!basic.suggestions.includes("/setready"));
  const power = getCompletions({ line: "/se", cursor: 3 }, baseCtx({ powerUserMode: true }));
  assert.ok(power.suggestions.includes("/setready"));
  console.log("completion.test.ts: PASS command-name completion respects power-user tier");
}

{
  // Chat escape ("//text") never triggers command completion.
  const result = getCompletions({ line: "//pa", cursor: 4 }, baseCtx());
  assert.deepStrictEqual(result.suggestions, []);
  console.log("completion.test.ts: PASS \"//\" chat escape yields no command completions");
}

// --- getCompletions: /set key completion ---

{
  const ctx = baseCtx({ settableKeys: ["name", "host", "port", "room"] });
  const result = getCompletions({ line: "/set ro", cursor: 7 }, ctx);
  assert.deepStrictEqual(result.suggestions, ["room"]);
  assert.strictEqual(result.replaceFrom, 5);
  console.log("completion.test.ts: PASS /set completes settable keys");
}

{
  // Once a value follows the key, no more key suggestions.
  const ctx = baseCtx({ settableKeys: ["name", "host", "port", "room"] });
  const result = getCompletions({ line: "/set room lobby", cursor: 15 }, ctx);
  assert.deepStrictEqual(result.suggestions, []);
  console.log("completion.test.ts: PASS /set stops suggesting keys once a value is being typed");
}

// --- getCompletions: /sr, /snr username completion ---

{
  const ctx = baseCtx({ users: [user("alice", "lobby"), user("alicia", "lobby"), user("bob", "lobby")] });
  const result = getCompletions({ line: "/sr al", cursor: 6 }, ctx);
  assert.deepStrictEqual(result.suggestions, ["alice", "alicia"]);
  console.log("completion.test.ts: PASS /sr completes usernames");
}

// --- getCompletions: /r room completion ---

{
  const ctx = baseCtx({ users: [user("alice", "movie-night"), user("bob", "movies")] });
  const result = getCompletions({ line: "/r movie", cursor: 8 }, ctx);
  assert.deepStrictEqual(result.suggestions, ["movie-night", "movies"]);
  console.log("completion.test.ts: PASS /r completes distinct room names");
}

// --- getCompletions: /qs, /qd playlist index completion ---

{
  const ctx = baseCtx({ playlistFiles: ["foo.mkv", "bar.mkv", "foobar.mkv"] });
  const empty = getCompletions({ line: "/qs ", cursor: 4 }, ctx);
  assert.deepStrictEqual(empty.suggestions, ["1", "2", "3"]);

  const byIndex = getCompletions({ line: "/qs 1", cursor: 5 }, ctx);
  assert.deepStrictEqual(byIndex.suggestions, ["1"]);

  const byName = getCompletions({ line: "/qd foo", cursor: 7 }, ctx);
  assert.deepStrictEqual(byName.suggestions, ["1", "3"]);
  console.log("completion.test.ts: PASS /qs and /qd complete indices and filename substrings");
}

// --- getCompletions: /qa, /qas file completion wiring (delegates to fileCompleter) ---

{
  const dir = mkdtempSync(join(tmpdir(), "platty-completion-qa-"));
  writeFileSync(join(dir, "movie.mkv"), "");
  try {
    const ctx = baseCtx();
    const line = `/qa ${dir}/mov`;
    const result = getCompletions({ line, cursor: line.length }, ctx);
    assert.deepStrictEqual(result.suggestions, [`${dir}/movie.mkv`]);
    assert.strictEqual(result.replaceFrom, 4);
    console.log("completion.test.ts: PASS /qa delegates to fileCompleter");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- suggestion overlay scroll ---

assert.strictEqual(suggestionScrollOffset(0, 3), 0);
assert.strictEqual(suggestionScrollOffset(null, 20), 0);
assert.strictEqual(suggestionScrollOffset(4, 8), 0);
assert.strictEqual(suggestionScrollOffset(5, 8), 1);
assert.strictEqual(suggestionScrollOffset(7, 8), 3);
assert.strictEqual(suggestionScrollOffset(19, 20), 15);
console.log("completion.test.ts: PASS suggestionScrollOffset");

console.log("completion.test.ts: ALL PASS");

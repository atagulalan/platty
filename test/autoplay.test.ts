// Autoplay/readiness aggregation parity tests — mirrors source/syncplay/client.py userlist helpers
// and autoplayConditionsMet() semantics.

import assert from "node:assert";
import { UserList } from "../src/client/UserList.js";

function testUserListCounts(): void {
  const list = new UserList();
  list.upsert("Alice", { room: "room", ready: true, file: { name: "a.mkv", size: 1, duration: 100 } });
  list.upsert("Bob", { room: "room", ready: true, file: { name: "a.mkv", size: 1, duration: 100 } });
  list.upsert("Carol", { room: "room", ready: false, file: { name: "a.mkv", size: 1, duration: 100 } });
  list.upsert("Dave", { room: "room", ready: true, file: null });

  assert.strictEqual(list.usersInRoomCount("room", "Alice"), 2, "counts self + ready users with files");
  assert.strictEqual(list.readyUserCount("room", "Alice"), 2, "counts ready self + ready others with files");
  assert.strictEqual(list.areAllUsersInRoomReady("room", "Alice"), false, "Carol blocks all-ready");
  assert.strictEqual(list.areAllOtherUsersInRoomReady("room", "Alice"), false);
  assert.strictEqual(list.onlyUserInRoomWhoSupportsReadiness("room", "Alice"), false, "Bob has a file");
}

function testSoloUserReadinessSupportedGate(): void {
  const list = new UserList();
  list.upsert("Alice", { room: "room", ready: true, file: { name: "a.mkv", size: 1, duration: 100 } });
  assert.strictEqual(list.onlyUserInRoomWhoSupportsReadiness("room", "Alice"), true);
  assert.strictEqual(list.areAllOtherUsersInRoomReady("room", "Alice"), true, "no other users");
}

function testRequireSameFilenames(): void {
  const list = new UserList();
  list.upsert("Alice", { room: "room", ready: true, file: { name: "a.mkv", size: 1, duration: 100 } });
  list.upsert("Bob", { room: "room", ready: true, file: { name: "b.mkv", size: 1, duration: 100 } });
  assert.strictEqual(list.areAllUsersInRoomReady("room", "Alice", false), true);
  assert.strictEqual(list.areAllUsersInRoomReady("room", "Alice", true), false);
}

function main(): void {
  testUserListCounts();
  testSoloUserReadinessSupportedGate();
  testRequireSameFilenames();
  console.log("autoplay.test.ts: ok");
}

main();

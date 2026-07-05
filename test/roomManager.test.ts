import assert from "node:assert/strict";
import { RoomManager } from "../src/server/RoomManager.js";
import { Room } from "../src/server/Room.js";
import type { Watcher } from "../src/server/Watcher.js";

function stubWatcher(name: string, room: Room): Watcher {
  return { name, room, connection: null! } as Watcher;
}

function managerWithNames(...names: string[]): RoomManager {
  const mgr = new RoomManager({ isolateRooms: false });
  const room = mgr.getOrCreateRoom("TestRoom");
  for (const name of names) {
    room.addWatcher(stubWatcher(name, room));
  }
  return mgr;
}

function testFindFreeUsername(): void {
  const oneXava = managerWithNames("xava");
  assert.strictEqual(oneXava.findFreeUsername("xava", 150), "xava_");
  assert.strictEqual(oneXava.findFreeUsername("XAVA", 150), "XAVA_");
  assert.strictEqual(oneXava.findFreeUsername("Alice", 150), "Alice");

  const twoTaken = managerWithNames("xava", "xava_");
  assert.strictEqual(twoTaken.findFreeUsername("xava", 150), "xava__");
  assert.strictEqual(twoTaken.findFreeUsername("xava_", 150), "xava__");

  const xavaAndDouble = managerWithNames("xava", "xava__");
  assert.strictEqual(xavaAndDouble.findFreeUsername("xava_", 150), "xava_");

  assert.strictEqual(managerWithNames("_").findFreeUsername("_", 150), "__");
}

testFindFreeUsername();
console.log("roomManager.test.ts: PASS");

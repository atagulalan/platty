// End-to-end smoke test: real TCP server + two real clients (NullPlayer, no mpv/VLC needed).
// Exercises the actual wire protocol - Hello handshake, Set.file/Set.user broadcast, State sync
// with the ignoringOnTheFly flow control, Chat, room switching, and playlist add/select.
// Run with: npx tsx test/smoke.ts

import assert from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SyncServer } from "../src/server/SyncServer.js";
import { SyncplayClient } from "../src/client/SyncplayClient.js";
import { NullPlayer } from "../src/players/NullPlayer.js";
import type { PlayerFileInfo } from "../src/players/BasePlayer.js";

const PORT = 34567;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForEvent<
  T extends { on(event: string, listener: (...args: never[]) => void): unknown },
>(emitter: T, event: string, timeoutMs = 5000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for '${event}'`)),
      timeoutMs,
    );
    emitter.on(event, (...args: never[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

async function main(): Promise<void> {
  const log = (msg: string): void => console.log(`[smoke] ${msg}`);

  const server = new SyncServer({ port: PORT, host: "127.0.0.1", log: () => {} });
  await server.listen();
  log(`server listening on ${PORT}`);

  const playerA = new NullPlayer();
  const playerB = new NullPlayer();
  // unpauseAction: "Always" - this smoke test exercises general state-sync plumbing, not the
  // instaplay/autoplay readiness gating (see SyncplayClient's instaplayConditionsMet()), so force
  // unpauses to always propagate regardless of either user's readiness.
  const clientA = new SyncplayClient(
    { host: "127.0.0.1", port: PORT, username: "Alice", room: "TestRoom", unpauseAction: "Always" },
    playerA,
  );
  const clientB = new SyncplayClient(
    { host: "127.0.0.1", port: PORT, username: "Bob", room: "TestRoom", unpauseAction: "Always" },
    playerB,
  );

  const aConnected = waitForEvent(clientA, "connected");
  const bConnected = waitForEvent(clientB, "connected");
  await clientA.start();
  await clientB.start();
  await aConnected;
  await bConnected;
  log("PASS: both clients completed the Hello handshake");

  assert.strictEqual(clientA.selfUsername, "Alice");
  assert.strictEqual(clientB.selfUsername, "Bob");

  // --- Hello username collision resolution -------------------------------------------------
  const clientA2Player = new NullPlayer();
  const clientA2 = new SyncplayClient(
    { host: "127.0.0.1", port: PORT, username: "Alice", room: "TestRoom" },
    clientA2Player,
  );
  const a2Connected = waitForEvent(clientA2, "connected");
  await clientA2.start();
  await a2Connected;
  assert.strictEqual(
    clientA2.selfUsername,
    "Alice_",
    "server should rename colliding username to Alice_",
  );
  log("PASS: server-side username collision resolution (Alice -> Alice_)");
  clientA2.stop();

  // --- File announcement + userlist propagation --------------------------------------------
  const bUserlistUpdate = waitForEvent(clientB, "userlistUpdate");
  await playerA.open("/videos/BigBuckBunny.avi");
  await bUserlistUpdate;
  await wait(200); // allow List round-trip to settle
  const aliceAsSeenByBob = clientB.userList.get("Alice");
  assert.ok(aliceAsSeenByBob?.file, "Bob should see Alice's file info");
  assert.strictEqual(aliceAsSeenByBob!.file!.name, "BigBuckBunny.avi");
  log("PASS: file info propagated from Alice to Bob via Set.user");

  // --- Chat ---------------------------------------------------------------------------------
  const bChat = waitForEvent(clientB, "chat");
  clientA.sendChat("hello from Alice");
  const [chatUser, chatMessage] = (await bChat) as [string, string];
  assert.strictEqual(chatUser, "Alice");
  assert.strictEqual(chatMessage, "hello from Alice");
  log("PASS: chat relay Alice -> Bob");

  // --- State sync: Alice unpauses, Bob's player should follow --------------------------------
  playerA.setPaused(false);
  await wait(1500); // let the 1s state ticker + sync propagate
  // NullPlayer's ticker emits a 'status' event every 250ms regardless of pause state, so the
  // next tick reflects whatever the sync algorithm has already applied to playerB by now.
  const bobStatus = (await waitForEvent(playerB, "status")) as [{ paused: boolean }];
  assert.strictEqual(
    bobStatus[0].paused,
    false,
    "Bob's player should have been unpaused by the sync algorithm",
  );
  log("PASS: unpause propagated Alice -> Bob via State + sync algorithm");

  // --- Playlist -------------------------------------------------------------------------------
  const bPlaylistUpdate = waitForEvent(clientB, "playlistUpdate");
  clientA.addToPlaylist("episode1.mkv");
  await bPlaylistUpdate;
  assert.deepStrictEqual(clientB.playlist.files, ["episode1.mkv"]);
  log("PASS: playlist add propagated Alice -> Bob");

  // --- Auto file switch on join via shared playlist index -------------------------
  const mediaDir = await mkdtemp(join(tmpdir(), "splatty-smoke-"));
  const sharedFile = join(mediaDir, "shared.mkv");
  await writeFile(sharedFile, "");

  const playerA3 = new NullPlayer();
  const playerB3 = new NullPlayer();
  const mediaOpts = { mediaSearchDirectories: [mediaDir], sharedPlaylistEnabled: true };
  const clientA3 = new SyncplayClient(
    { host: "127.0.0.1", port: PORT, username: "Carol", room: "PlaylistRoom", ...mediaOpts },
    playerA3,
  );
  const clientB3 = new SyncplayClient(
    { host: "127.0.0.1", port: PORT, username: "Dave", room: "PlaylistRoom", ...mediaOpts },
    playerB3,
  );

  await clientA3.start();
  await waitForEvent(clientA3, "connected");
  clientA3.addToPlaylist("shared.mkv");
  const carolFilePromise = waitForEvent(playerA3, "fileInfo");
  clientA3.selectPlaylistIndex(0);
  const carolFile = (await carolFilePromise) as [PlayerFileInfo];
  assert.strictEqual(carolFile[0].name, "shared.mkv");

  const b3FileInfo = waitForEvent(playerB3, "fileInfo");
  await clientB3.start();
  await waitForEvent(clientB3, "connected");
  const daveFile = (await b3FileInfo) as [PlayerFileInfo];
  assert.strictEqual(
    daveFile[0].name,
    "shared.mkv",
    "Dave should auto-open shared.mkv from media dir on join",
  );
  log("PASS: auto file switch on room join via shared playlist index");

  clientA3.stop();
  clientB3.stop();

  // --- Room switching ------------------------------------------------------------------------
  // With --isolate-rooms OFF (the default), userlist visibility is server-wide, not room-scoped -
  // that's the whole point of isolate-rooms being an opt-in feature (see
  // spec/server/rooms-and-permissions.md#room-isolation). So Bob should still see Alice after
  // she switches rooms, just with her `room` field updated - not removed entirely.
  const bSeesRoomChange = waitForEvent(clientB, "userlistUpdate");
  clientA.changeRoom("OtherRoom");
  await bSeesRoomChange;
  await wait(100);
  const aliceAfterSwitch = clientB.userList.get("Alice");
  assert.ok(aliceAfterSwitch, "Bob should still see Alice server-wide (isolate-rooms is off)");
  assert.strictEqual(aliceAfterSwitch!.room, "OtherRoom", "Bob should see Alice's updated room");
  log("PASS: room switch updates Alice's room in Bob's (non-isolated, server-wide) userlist");

  clientA.stop();
  clientB.stop();
  await server.close();
  log("ALL SMOKE TESTS PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});

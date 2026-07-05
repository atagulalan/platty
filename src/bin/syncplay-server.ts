// CLI entry point for the server (run via `npm run server -- [options]`).
// See ../../spec/server/overview-and-cli.md#full-cli-reference.

import { Command } from "commander";
import { SyncServer } from "../server/SyncServer.js";
import { DEFAULT_PORT } from "../protocol/constants.js";

const program = new Command();
program
  .name("syncplay-server")
  .description("TypeScript reimplementation of the Syncplay server")
  .option("--port <port>", "listen port", String(DEFAULT_PORT))
  .option("--host <host>", "bind address", "0.0.0.0")
  .option("--password <password>", "shared server password (env SYNCPLAY_PASSWORD)")
  .option("--salt <salt>", "salt for managed-room password hashing (env SYNCPLAY_SALT)")
  .option("--motd-file <path>", "message-of-the-day template file")
  .option("--isolate-rooms", "scope broadcasts/userlists to each room", false)
  .option("--disable-ready", "disable the readiness feature", false)
  .option("--disable-chat", "disable chat relaying", false)
  .option("--max-chat-message-length <n>", "chat truncation limit", (v) => Number(v))
  .option("--max-username-length <n>", "username truncation limit", (v) => Number(v))
  .option("--rooms-db-file <path>", "persist room playlists/index across restarts")
  .option(
    "--permanent-rooms-file <path>",
    "newline-delimited room names that are never deleted when empty",
  )
  .option("--stats-db-file <path>", "record hourly connection-count/version-histogram snapshots")
  .option("--tls <cert-dir>", "directory containing cert.pem/key.pem; enables in-band STARTTLS")
  .option("--ipv4-only", "only bind an IPv4 listener", false)
  .option("--ipv6-only", "only bind an IPv6 listener", false)
  .option(
    "--interface-ipv4 <addr>",
    "explicit IPv4 bind address (implies dual-stack if --interface-ipv6 also given)",
  )
  .option(
    "--interface-ipv6 <addr>",
    "explicit IPv6 bind address (implies dual-stack if --interface-ipv4 also given)",
  )
  .parse(process.argv);

const opts = program.opts();

const server = new SyncServer({
  port: Number(opts.port),
  host: opts.host,
  // CLI flag wins; fall back to the env vars the reference server documents for headless/
  // container deployments where passing secrets as argv is undesirable.
  password: opts.password ?? process.env.SYNCPLAY_PASSWORD,
  salt: opts.salt ?? process.env.SYNCPLAY_SALT,
  motdFile: opts.motdFile,
  isolateRooms: !!opts.isolateRooms,
  disableReady: !!opts.disableReady,
  disableChat: !!opts.disableChat,
  maxChatMessageLength: opts.maxChatMessageLength,
  maxUsernameLength: opts.maxUsernameLength,
  roomsDbFile: opts.roomsDbFile,
  permanentRoomsFile: opts.permanentRoomsFile,
  statsDbFile: opts.statsDbFile,
  tlsCertDir: opts.tls,
  ipv4Only: !!opts.ipv4Only,
  ipv6Only: !!opts.ipv6Only,
  interfaceIpv4: opts.interfaceIpv4,
  interfaceIpv6: opts.interfaceIpv6,
});

server
  .listen()
  .then(() => {
    console.log(`syncplay-ts server listening on ${opts.host}:${opts.port}`);
  })
  .catch((err: unknown) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });

process.on("SIGINT", () => {
  void server.close().then(() => process.exit(0));
});

import React from "react";
import { Box, Text } from "ink";
import type { UserInfo } from "../../client/UserList.js";
import { ConnectionHeader, type ConnectionStatus } from "./StatusBar.js";
import { UserListPanel } from "./UserListPanel.js";
import { PlaylistPanel } from "./PlaylistPanel.js";

export interface LeftColumnPanelProps {
  status: ConnectionStatus;
  powerUserMode?: boolean;
  users: UserInfo[];
  selfUsername: string;
  room: string;
  usersFocused: boolean;
  usersCursorIndex: number;
  usersVisibleLines: number;
  playlistFiles: string[];
  playlistIndex: number | null;
  playlistFocused: boolean;
  playlistCursorIndex: number;
  playlistVisibleLines: number;
  width: number;
  height: number;
}

/** Horizontal rule between stacked sections inside one rounded border. */
function SectionDivider({ width }: { width: number }): React.JSX.Element {
  // Parent uses paddingX={1} and a round border (2 cols); inner text width ≈ width - 4.
  const line = "─".repeat(Math.max(1, width - 4));
  return (
    <Text dimColor color="gray">
      {line}
    </Text>
  );
}

export function LeftColumnPanel({
  status,
  powerUserMode,
  users,
  selfUsername,
  room,
  usersFocused,
  usersCursorIndex,
  usersVisibleLines,
  playlistFiles,
  playlistIndex,
  playlistFocused,
  playlistCursorIndex,
  playlistVisibleLines,
  width,
  height,
}: LeftColumnPanelProps): React.JSX.Element {
  const columnFocused = usersFocused || playlistFocused;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={columnFocused ? "yellow" : "gray"}
      paddingX={1}
      width={width}
      height={height}
      flexShrink={0}
      overflow="hidden"
    >
      <ConnectionHeader status={status} powerUserMode={powerUserMode} />
      <SectionDivider width={width} />
      <UserListPanel
        embedded
        users={users}
        selfUsername={selfUsername}
        room={room}
        focused={usersFocused}
        cursorIndex={usersCursorIndex}
        visibleLines={usersVisibleLines}
      />
      <SectionDivider width={width} />
      <PlaylistPanel
        embedded
        files={playlistFiles}
        index={playlistIndex}
        focused={playlistFocused}
        cursorIndex={playlistCursorIndex}
        visibleLines={playlistVisibleLines}
      />
    </Box>
  );
}

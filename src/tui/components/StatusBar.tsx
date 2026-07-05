import React from "react";
import { Box, Text } from "ink";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  connecting: "yellow",
  connected: "green",
  disconnected: "red",
  reconnecting: "yellow",
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: "CONNECTING",
  connected: "CONNECTED",
  disconnected: "DISCONNECTED",
  reconnecting: "RECONNECTING",
};

export interface ConnectionHeaderProps {
  status: ConnectionStatus;
  powerUserMode?: boolean;
}

/** Connection summary at the top of the left column (below the outer border). */
export function ConnectionHeader({
  status,
  powerUserMode,
}: ConnectionHeaderProps): React.JSX.Element {
  return (
    <Box justifyContent="space-between">
      {powerUserMode ? (
        <Text bold color="black" backgroundColor="yellow">
          {"PERRY!"}
        </Text>
      ) : (
        <Box gap={0} width={5}>
          <Text color="yellow">▁</Text>
          <Text color="cyan">█</Text>
          <Text color="yellow">─</Text>
        </Box>
      )}
      <Text color={STATUS_COLOR[status]} bold>
        ● {STATUS_LABEL[status]}
      </Text>
    </Box>
  );
}

export interface InputUserStatusProps {
  username: string;
  ready: boolean | null;
}

/** Self username + readiness shown to the right of the command input. */
export function InputUserStatus({ username, ready }: InputUserStatusProps): React.JSX.Element {
  return (
    <Box gap={1} flexShrink={0}>
      <Text bold>{username}</Text>
      <Text color={ready ? "green" : "gray"}>{ready ? "✓ ready" : "○ not ready"}</Text>
    </Box>
  );
}

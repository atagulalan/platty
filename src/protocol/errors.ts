// Error message catalogue. See ../../../spec/protocol/message-reference.md#errors.
// There is deliberately no "version mismatch" or "room/username/message too long" error -
// the reference implementation truncates/reverts those silently instead of rejecting them.

export const ProtocolError = {
  unknownCommand: (raw: string) => `Unknown command ${raw}`,
  notJson: (line: string) => `Not a json encoded string ${line}`,
  lineDecode: () => "Not a utf-8 string",
  notKnown: () => "You must be known to server before sending this command",
  hello: () => "Not enough Hello arguments",
  passwordRequired: () => "Password required",
  wrongPassword: () => "Wrong password supplied",
} as const;

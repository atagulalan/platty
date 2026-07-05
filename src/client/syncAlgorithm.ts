// The client sync decision tree, as a pure function for testability. See
// ../../../spec/client/sync-algorithm.md - numeric thresholds and evaluation order mirror that
// document exactly; get this wrong and mixed-client rooms visibly fight each other.

import {
  DEFAULT_FASTFORWARD_THRESHOLD_S,
  DEFAULT_REWIND_THRESHOLD_S,
  DEFAULT_SLOWDOWN_KICKIN_THRESHOLD_S,
  FASTFORWARD_BEHIND_THRESHOLD_S,
  FASTFORWARD_EXTRA_TIME_S,
  FASTFORWARD_RESET_THRESHOLD_S,
  SLOWDOWN_RATE,
  SLOWDOWN_RESET_THRESHOLD_S,
  SYNC_ON_PAUSE,
} from "../protocol/constants.js";

export interface SyncConfig {
  rewindThreshold: number;
  fastforwardThreshold: number;
  slowdownThreshold: number;
  rewindOnDesync: boolean;
  fastforwardOnDesync: boolean;
  slowOnDesync: boolean;
  dontSlowDownWithMe: boolean;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  rewindThreshold: DEFAULT_REWIND_THRESHOLD_S,
  fastforwardThreshold: DEFAULT_FASTFORWARD_THRESHOLD_S,
  slowdownThreshold: DEFAULT_SLOWDOWN_KICKIN_THRESHOLD_S,
  rewindOnDesync: true,
  fastforwardOnDesync: true,
  slowOnDesync: true,
  dontSlowDownWithMe: false,
};

export interface SyncInputs {
  /** Wall-clock-extrapolated local player position (seconds). */
  playerPosition: number;
  playerPaused: boolean;
  /** Wall-clock-extrapolated authoritative position, already advanced by ping messageAge. */
  globalPosition: number;
  globalPaused: boolean;
  doSeek: boolean;
  setBy: string | null;
  selfUsername: string;
  isFirstUpdate: boolean;
  canControl: boolean;
  speedSupported: boolean;
  config: SyncConfig;
  /** Hysteresis timer state carried across calls; pass back what this function returns. */
  behindFirstDetected: number | null;
  currentlySlowed: boolean;
  /** Seconds, e.g. Date.now() / 1000. */
  now: number;
}

export interface SyncDecision {
  seekTo?: number;
  setPaused?: boolean;
  setSpeed?: number;
  behindFirstDetected: number | null;
  /**
   * True when seekTo came from the "player too far ahead" rewind-on-desync branch below (as
   * opposed to a first-update sync or someone else's discrete seek). The caller uses this to
   * arm the rewind anti-oscillation guard - see client.py's establishRewindDoubleCheck() and
   * the post-rewind seek-suppression window at client.py ~825-830.
   */
  isRewind?: boolean;
  isFastForward?: boolean;
}

export function decideSyncAction(input: SyncInputs): SyncDecision {
  const {
    playerPosition,
    playerPaused,
    globalPosition,
    globalPaused,
    doSeek,
    setBy,
    selfUsername,
    isFirstUpdate,
    canControl,
    speedSupported,
    config,
    currentlySlowed,
    now,
  } = input;
  let behindFirstDetected = input.behindFirstDetected;

  // 1. First-ever update: sync immediately, no thresholds.
  if (isFirstUpdate) {
    return { seekTo: globalPosition, setPaused: globalPaused, behindFirstDetected: null };
  }

  const decision: SyncDecision = { behindFirstDetected };
  const diff = playerPosition - globalPosition; // positive = player ahead, negative = behind

  // 2. Discrete seek from someone else - unconditional jump.
  if (doSeek && setBy !== selfUsername) {
    decision.seekTo = globalPosition;
    decision.behindFirstDetected = null;
    applyPauseDecision();
    return decision;
  }

  // 3. Rewind: player too far ahead.
  if (config.rewindOnDesync && !doSeek && diff > config.rewindThreshold) {
    decision.seekTo = globalPosition;
    decision.behindFirstDetected = null;
    decision.isRewind = true;
    applyPauseDecision();
    return decision;
  }

  // 4. Fast-forward: player too far behind. Normally only for non-controllers, unless
  //    dontSlowDownWithMe is set (in which case this client must self-correct instead of
  //    asking the room to wait for it).
  const fastforwardEligible = !canControl || config.dontSlowDownWithMe;
  if (config.fastforwardOnDesync && fastforwardEligible && !doSeek) {
    if (diff < -FASTFORWARD_BEHIND_THRESHOLD_S) {
      if (behindFirstDetected === null) behindFirstDetected = now;
      const durationBehind = now - behindFirstDetected;
      if (
        durationBehind > config.fastforwardThreshold - FASTFORWARD_BEHIND_THRESHOLD_S &&
        diff < -config.fastforwardThreshold
      ) {
        decision.seekTo = globalPosition + FASTFORWARD_EXTRA_TIME_S;
        decision.isFastForward = true;
        behindFirstDetected = now + FASTFORWARD_RESET_THRESHOLD_S; // refractory cooldown
      }
    } else {
      behindFirstDetected = null;
    }
  }
  decision.behindFirstDetected = behindFirstDetected;
  if (decision.seekTo !== undefined) {
    applyPauseDecision();
    return decision;
  }

  // 5. Slowdown: player mildly ahead - gentle correction instead of a hard seek.
  if (speedSupported && config.slowOnDesync && !doSeek && !playerPaused) {
    if (!currentlySlowed && diff > config.slowdownThreshold) {
      decision.setSpeed = SLOWDOWN_RATE;
    } else if (currentlySlowed && diff < SLOWDOWN_RESET_THRESHOLD_S) {
      decision.setSpeed = 1.0;
    }
  }

  applyPauseDecision();
  return decision;

  function applyPauseDecision(): void {
    if (globalPaused === playerPaused) return;
    decision.setPaused = globalPaused;
    // On pause (not self-initiated), snap to the authoritative position first - this is why
    // other participants can visibly "jump" when someone else pauses.
    if (globalPaused && SYNC_ON_PAUSE && setBy !== selfUsername) {
      decision.seekTo = globalPosition;
    }
  }
}

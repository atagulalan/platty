// RTT / EWMA / forward-delay estimation, identical on both client and server sides.
// See ../../spec/protocol/ping-and-latency.md - both peers run this same algorithm
// independently, feeding it each other's self-reported numbers.

import { PING_MOVING_AVERAGE_WEIGHT } from "./constants.js";

export class PingService {
  private rtt = 0;
  private avrRtt = 0;
  private forwardDelay = 0;
  private hasSample = false;

  /** A fresh outbound timestamp, to be echoed back by the peer later. */
  newTimestamp(): number {
    return Date.now() / 1000;
  }

  /**
   * Call when an incoming message carries a timestamp this side generated earlier
   * (now echoed back by the peer), plus the peer's own last-measured RTT.
   */
  receiveMessage(timestamp: number, senderRtt: number): void {
    if (!timestamp) return; // first-ever exchange: peer has nothing to echo yet

    const rtt = this.newTimestamp() - timestamp;
    if (rtt < 0 || senderRtt < 0) return; // guard against clock skew / bogus data

    this.rtt = rtt;
    this.avrRtt = this.hasSample ? this.avrRtt * PING_MOVING_AVERAGE_WEIGHT + rtt * (1 - PING_MOVING_AVERAGE_WEIGHT) : rtt;
    this.hasSample = true;

    this.forwardDelay = senderRtt < rtt ? this.avrRtt / 2 + (rtt - senderRtt) : this.avrRtt / 2;
  }

  getLastForwardDelay(): number {
    return this.forwardDelay;
  }

  getRtt(): number {
    return this.rtt;
  }
}

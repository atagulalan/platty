// Mirrors source/syncplay/utils.py formatTime() — used in pause/seek OSD notifications.

export function formatTime(totalSeconds: number): string {
  const negative = totalSeconds < 0;
  let seconds = Math.abs(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  const wholeSeconds = Math.floor(seconds);
  const millis = Math.round((seconds - wholeSeconds) * 1000);

  let formatted: string;
  if (hours > 0) {
    formatted = `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}`;
  } else {
    formatted = `${minutes}:${String(wholeSeconds).padStart(2, "0")}`;
  }
  if (millis > 0) {
    formatted += `.${String(millis).padStart(3, "0").replace(/0+$/, "")}`;
  }
  return negative ? `-${formatted}` : formatted;
}

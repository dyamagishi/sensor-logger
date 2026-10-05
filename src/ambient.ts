export const PAGE_DURATIONS = [30 * 60_000, 20_000, 20_000] as const;
export const IDLE_DELAY = 2 * 60_000;
export const CO2_NOTICE = 1500;

/** Adjacent screens in a loop must slide one step, including the last/first edge. */
export function slideDirection(from:number,to:number,count:number) {
  const forward=((to-from)%count+count)%count;
  if(forward===0)return 0;
  return forward<=count/2?1:-1;
}

export function isNight(date = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23' }).format(date));
  return hour < 7;
}

/** Wall-clock deadlines, not accumulated interval ticks (iPad can suspend tabs). */
export class AmbientRotation {
  page = 0;
  private nextAt: number;
  private idleUntil = 0;
  private paused = false;

  constructor(now = Date.now()) { this.nextAt = now + PAGE_DURATIONS[0]; }

  select(page: number, now = Date.now()) {
    this.page = ((page % PAGE_DURATIONS.length) + PAGE_DURATIONS.length) % PAGE_DURATIONS.length;
    this.nextAt = now + PAGE_DURATIONS[this.page];
  }

  interact(now = Date.now()) {
    this.idleUntil = now + IDLE_DELAY;
    this.paused = true;
  }

  tick(now = Date.now(), blocked = false) {
    if (blocked) { this.interact(now); return false; }
    if (this.paused) {
      if (now < this.idleUntil) return false;
      this.paused = false;
      this.nextAt = now + PAGE_DURATIONS[this.page];
      return false;
    }
    if (now < this.nextAt) return false;
    this.select(this.page + 1, now);
    return true;
  }
}

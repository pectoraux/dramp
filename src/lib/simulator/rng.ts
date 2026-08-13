// dRamp Network Simulator — Seeded RNG + Simulation Clock
//
// Deterministic reproducibility: same seed → same results.
// Uses a simple but effective mulberry32 PRNG.

export class SeededRNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6D2B79F5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  float(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }

  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  // Gaussian distribution via Box-Muller transform.
  gaussian(mean: number, stdDev: number): number {
    const u1 = this.next() || 0.0001;
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z * stdDev;
  }

  // Weighted pick: returns index based on weights.
  weighted(weights: number[]): number {
    const total = weights.reduce((s, w) => s + w, 0);
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }

  // Boolean with probability p.
  chance(p: number): boolean {
    return this.next() < p;
  }
}

export interface SimulationClock {
  step: number;       // current tick (0, 1, 2, ...)
  timeMs: number;     // simulated wall-clock time
  stepDurationMs: number; // duration of each step
}

export function createClock(stepDurationMs: number = 5000): SimulationClock {
  return { step: 0, timeMs: 0, stepDurationMs };
}

export function advanceClock(clock: SimulationClock): void {
  clock.step++;
  clock.timeMs += clock.stepDurationMs;
}

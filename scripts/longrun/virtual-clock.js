const MS_PER_DAY = 24 * 60 * 60 * 1000;

class VirtualClock {
  constructor(options = {}) {
    this.epochMs = Number(options.epochMs ?? Date.now());
    this.currentMs = this.epochMs;
    this.dayLengthMs = Number(options.dayLengthMs || MS_PER_DAY);
  }

  now() {
    return this.currentMs;
  }

  advance(ms) {
    this.currentMs += Number(ms || 0);
    return this.currentMs;
  }

  advanceDays(days) {
    return this.advance(Number(days || 0) * this.dayLengthMs);
  }

  setTime(timestamp) {
    this.currentMs = Number(timestamp);
    return this.currentMs;
  }

  async sleep(ms) {
    this.advance(ms);
    return this.currentMs;
  }

  getDayIndex() {
    return Math.floor((this.currentMs - this.epochMs) / this.dayLengthMs);
  }
}

module.exports = {
  VirtualClock,
  MS_PER_DAY,
};

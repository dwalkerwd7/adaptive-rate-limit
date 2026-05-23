let instance = null

class LoadMonitor {
  constructor(opts = {}) {
    this.minFactor = opts.minFactor ?? 0.3
    this.maxFactor = opts.maxFactor ?? 1.0
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000
    this.cpuThreshold = opts.cpuThreshold ?? 70

    this._timer = null
    this._lastUsage = null
    this._lastSampleAt = 0
    this._cpuPercent = 0
    this._factor = this.maxFactor
  }

  start() {
    if (this._timer) return
    this._lastUsage = process.cpuUsage()
    this._lastSampleAt = Date.now()
    this._timer = setInterval(() => this._poll(), this.pollIntervalMs)
    this._timer.unref()
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  _poll() {
    const now = Date.now()
    const usage = process.cpuUsage()
    const elapsedUs = (now - this._lastSampleAt) * 1000

    if (elapsedUs > 0) {
      const cpuDeltaUs = (usage.user - this._lastUsage.user) + (usage.system - this._lastUsage.system)
      this._cpuPercent = Math.min(100, (cpuDeltaUs / elapsedUs) * 100)
    }

    this._lastUsage = usage
    this._lastSampleAt = now
    this._factor = this._computeFactor()
  }

  _computeFactor() {
    if (this._cpuPercent <= this.cpuThreshold) return this.maxFactor
    const range = 100 - this.cpuThreshold
    if (range <= 0) return this.minFactor
    const ratio = (this._cpuPercent - this.cpuThreshold) / range
    return Math.max(this.minFactor, this.maxFactor - (this.maxFactor - this.minFactor) * ratio)
  }

  getLoadFactor() {
    return this._factor
  }

  getMetrics() {
    return {
      enabled: true,
      currentFactor: this._factor,
      cpuPercent: this._cpuPercent,
      lastSampleAt: this._lastSampleAt,
      cpuThreshold: this.cpuThreshold
    }
  }
}

// Returns the singleton, creating and starting it on first call with adaptive enabled.
// Subsequent calls with different opts are ignored — the first caller wins.
export function getMonitor(opts = {}) {
  if (!instance) {
    instance = new LoadMonitor(opts)
    instance.start()
  }
  return instance
}

// Returns the existing singleton without creating one (used by getLoadMetrics).
export function getInstance() {
  return instance
}

// Exposed for testing so the singleton can be torn down between test runs.
export function resetMonitor() {
  if (instance) {
    instance.stop()
    instance = null
  }
}

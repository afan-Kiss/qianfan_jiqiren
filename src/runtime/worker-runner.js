const { fork, exec } = require('child_process');
const { EventEmitter } = require('events');

const FORK_RETRY_DELAYS = [200, 500, 1000];
const RETRYABLE_FORK_CODES = new Set(['EPERM', 'EBUSY', 'EMFILE']);

class WorkerRunner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workerName = options.workerName;
    this.workerEntry = options.workerEntry;
    this.rootDir = options.rootDir;
    this.runtimeRoot = options.runtimeRoot || options.rootDir;
    this.logger = options.logger;
    this.forkFn = options.forkFn || fork;
    this.child = null;
    this.status = 'registered';
    this.pid = null;
    this.startTime = null;
    this.lastError = '';
    this.exitCode = null;
    this.stopRequested = false;
    this.stopTimer = null;
    this.killTimer = null;
    this.forceTimer = null;
    this.extraEnv = options.extraEnv || {};
    this._onStdout = null;
    this._onStderr = null;
    this._onMessage = null;
    this._onError = null;
    this._onExit = null;
  }

  static get FORK_RETRY_DELAYS() {
    return FORK_RETRY_DELAYS;
  }

  static isRetryableForkError(err) {
    const code = err?.code || '';
    return RETRYABLE_FORK_CODES.has(code);
  }

  log(level, message) {
    if (this.logger) {
      this.logger.write({ level, workerName: this.workerName, message });
    }
  }

  sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  clearStopTimers() {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    if (this.forceTimer) clearTimeout(this.forceTimer);
    this.stopTimer = null;
    this.killTimer = null;
    this.forceTimer = null;
  }

  unrefTimer(timer) {
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  detachChild() {
    const child = this.child;
    if (!child) return;

    if (this._onStdout && child.stdout) {
      child.stdout.removeListener('data', this._onStdout);
    }
    if (this._onStderr && child.stderr) {
      child.stderr.removeListener('data', this._onStderr);
    }
    if (this._onMessage) child.removeListener('message', this._onMessage);
    if (this._onError) child.removeListener('error', this._onError);
    if (this._onExit) child.removeListener('exit', this._onExit);

    if (child.connected) {
      try {
        child.disconnect();
      } catch {
        // ignore
      }
    }

    this._onStdout = null;
    this._onStderr = null;
    this._onMessage = null;
    this._onError = null;
    this._onExit = null;
    this.child = null;
  }

  discardFailedChild(child) {
    if (!child) return;
    try {
      child.removeAllListeners();
    } catch {
      // ignore
    }
    if (child.connected) {
      try {
        child.disconnect();
      } catch {
        // ignore
      }
    }
    try {
      child.kill();
    } catch {
      // ignore
    }
  }

  bindChild(child) {
    this.child = child;
    this.pid = child.pid;
    this.startTime = Date.now();

    this._onStdout = (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        this.log('info', text);
        this.emit('stdout', text);
      }
    };

    this._onStderr = (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        this.log('error', text);
        this.emit('stderr', text);
      }
    };

    this._onMessage = (message) => {
      this.emit('message', message);
    };

    this._onError = () => {
      // ignore IPC errors during worker restart/shutdown
    };

    this._onExit = (code, signal) => {
      this.exitCode = code;
      this.pid = null;
      const crashed = !this.stopRequested && code !== 0;
      this.status = crashed ? 'crashed' : 'stopped';
      if (crashed) {
        this.lastError = `exit code=${code} signal=${signal || 'none'}`;
      }
      this.detachChild();
      this.emit('exit', { code, signal, crashed });
    };

    child.stdout?.on('data', this._onStdout);
    child.stderr?.on('data', this._onStderr);
    child.on('message', this._onMessage);
    child.on('error', this._onError);
    child.on('exit', this._onExit);
  }

  tryForkOnce(oneShotEnv = {}) {
    let child;
    try {
      const env = {
        ...process.env,
        ...this.extraEnv,
        ...oneShotEnv,
        QIANFAN_WORKER_NAME: this.workerName,
        QIANFAN_RUNTIME_MODE: 'distributed',
        QIANFAN_APP_ROOT: this.rootDir,
        QIANFAN_RUNTIME_ROOT: this.runtimeRoot,
      };
      const simExplicit = this.extraEnv?.QIANFAN_SIM_MODE === '1'
        || oneShotEnv?.QIANFAN_SIM_MODE === '1';
      if (!simExplicit) {
        for (const key of Object.keys(env)) {
          if (key.startsWith('QIANFAN_SIM_')) delete env[key];
        }
      }

      child = this.forkFn(this.workerEntry, [], {
        cwd: this.rootDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (err) {
      if (WorkerRunner.isRetryableForkError(err)) {
        return Promise.resolve({ ok: false, retryable: true, error: err });
      }
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const finishOk = () => {
        if (settled) return;
        settled = true;
        child.removeListener('error', onStartupError);
        resolve({ ok: true, pid: child.pid });
      };

      const finishRetry = (err) => {
        if (settled) return;
        settled = true;
        child.removeListener('error', onStartupError);
        this.detachChild();
        this.discardFailedChild(child);
        resolve({ ok: false, retryable: true, error: err });
      };

      const onStartupError = (err) => {
        if (WorkerRunner.isRetryableForkError(err)) {
          finishRetry(err);
          return;
        }
        if (settled) return;
        settled = true;
        this.discardFailedChild(child);
        reject(err);
      };

      child.once('error', onStartupError);
      this.bindChild(child);
      finishOk();
    });
  }

  async start(oneShotEnv = {}) {
    if (
      this.child
      && !this.child.killed
      && this.child.exitCode == null
      && ['starting', 'running', 'registered'].includes(this.status)
    ) {
      return { ok: true, alreadyRunning: true, pid: this.child.pid, status: this.status };
    }

    this.stopRequested = false;
    this.status = 'starting';
    this.lastError = '';
    this.exitCode = null;

    const delays = FORK_RETRY_DELAYS;
    let lastError = null;

    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        const result = await this.tryForkOnce(oneShotEnv);
        if (result.ok) {
          return { ok: true, pid: this.pid, attempts: attempt + 1 };
        }

        lastError = result.error;
        if (attempt >= delays.length) {
          break;
        }

        const delayMs = delays[attempt];
        this.log(
          'warn',
          `fork retry ${attempt + 1}/${delays.length} after ${lastError.code}: ${lastError.message}, delay=${delayMs}ms`,
        );
        await this.sleep(delayMs);
      } catch (err) {
        lastError = err;
        break;
      }
    }

    this.detachChild();
    this.pid = null;
    this.status = 'failed';
    this.lastError = lastError?.message || 'worker fork failed';
    return { ok: false, status: 'failed', error: lastError };
  }

  send(message) {
    if (!this.child || this.child.killed) return false;
    try {
      this.child.send(message);
      return true;
    } catch {
      return false;
    }
  }

  killProcessTree(pid) {
    return new Promise((resolve) => {
      if (!pid) {
        resolve();
        return;
      }
      if (process.platform === 'win32') {
        exec(`taskkill /T /F /PID ${pid}`, () => resolve());
        return;
      }
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
      resolve();
    });
  }

  stop(reason = 'manual') {
    return new Promise((resolve) => {
      if (!this.child || this.child.killed || this.child.exitCode != null) {
        this.clearStopTimers();
        this.detachChild();
        this.pid = null;
        this.status = 'stopped';
        resolve({ ok: true, stopped: true, reason });
        return;
      }

      this.stopRequested = true;
      this.status = 'stopping';
      const pid = this.child.pid;
      const child = this.child;
      let finished = false;

      const finalize = (result) => {
        if (finished) return;
        finished = true;
        this.clearStopTimers();
        this.detachChild();
        this.pid = null;
        this.status = 'stopped';
        resolve(result);
      };

      const onExit = () => {
        finalize({ ok: true, stopped: true, reason });
      };

      child.once('exit', onExit);

      this.send({ type: 'shutdown', reason });

      this.stopTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }, 3000);
      this.unrefTimer(this.stopTimer);

      this.killTimer = setTimeout(() => {
        void this.killProcessTree(pid).finally(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        });
      }, 8000);
      this.unrefTimer(this.killTimer);

      this.forceTimer = setTimeout(() => {
        child.removeListener('exit', onExit);
        finalize({ ok: true, stopped: true, reason: `${reason}:force-timeout` });
      }, 10000);
      // forceTimer must stay ref'd so stop() always resolves during cleanup
    });
  }

  restart(reason = 'manual') {
    return this.stop(reason).then(() => this.start());
  }

  getStatus() {
    return {
      workerName: this.workerName,
      status: this.status,
      pid: this.pid,
      startTime: this.startTime,
      lastError: this.lastError,
      exitCode: this.exitCode,
      running: Boolean(this.child && !this.child.killed && this.child.exitCode == null),
    };
  }
}

module.exports = {
  WorkerRunner,
  FORK_RETRY_DELAYS,
  RETRYABLE_FORK_CODES,
};

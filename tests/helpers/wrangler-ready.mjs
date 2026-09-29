/** Read the bound loopback address from the owned Wrangler child's IPC channel.
 * The worker must bind port 0 itself; probing then releasing a port has a race.
 * @param {import('node:child_process').ChildProcess} child
 * @param {() => string} readLogs
 * @param {number} timeoutMs
 * @returns {Promise<{ip:string,port:number}>}
 */
export function waitForWranglerReady(child, readLogs, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, address) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error) reject(error); else resolve(address);
    };
    const onError = error => finish(error);
    const onExit = (code, signal) => finish(new Error(
      `scheduling rules authorization worker exited before readiness: ${code ?? signal}\n${readLogs()}`,
    ));
    const onMessage = raw => {
      let message;
      try { message = typeof raw === 'string' ? JSON.parse(raw) : raw; }
      catch { return; }
      if (message?.event !== 'DEV_SERVER_READY') return;
      if (message.ip !== '127.0.0.1' || !Number.isInteger(message.port) ||
          message.port < 1024 || message.port > 65535) {
        finish(new Error('Wrangler readiness did not contain a bound loopback port'));
        return;
      }
      finish(null, {ip: message.ip, port: message.port});
    };
    const timer = setTimeout(() => finish(new Error(
      `scheduling rules authorization worker did not report readiness\n${readLogs()}`,
    )), timeoutMs);
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
    }
  });
}

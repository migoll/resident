/** The one process-spawn helper. No shell, ever — commands are arg arrays.
 *  `out` is stdout+stderr combined (for humans: logs, evidence, error detail);
 *  `stdout` is stdout alone (for machines: JSON.parse targets — gh/git can write
 *  warnings to stderr that would corrupt combined output). */
export async function run(
  cmd: string[],
  cwd?: string,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; out: string; stdout: string }> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL', env: { ...process.env } })
    const [so, se] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    const code = await p.exited
    return { ok: code === 0, stdout: so.trim(), out: (so + (se ? '\n' + se : '')).trim() }
  } catch (e) {
    return { ok: false, stdout: '', out: String(e) }
  }
}

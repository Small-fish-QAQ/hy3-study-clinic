import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

export function acquireDatabaseLock(databasePath: string): () => void {
  if (databasePath === ':memory:') return () => {};
  const lock = `${resolve(databasePath)}.server-lock`;
  mkdirSync(dirname(lock), { recursive: true });
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    let running = true;
    try {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error();
      process.kill(pid, 0);
    } catch {
      running = false;
    }
    if (running)
      throw new Error('该数据库已有 Study Clinic server 运行，请使用现有进程或独立新库。');
    unlinkSync(lock);
  }
  const fd = openSync(lock, 'wx');
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (existsSync(lock) && readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock);
  };
}

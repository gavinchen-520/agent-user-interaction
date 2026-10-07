import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type PageStore = {
  readonly dir: string;
  path(sessionId: string, pageVersion: number): string;
  write(sessionId: string, pageVersion: number, html: string): Promise<string>;
  exists(path: string): boolean;
  listSessionIds(): string[];
  removeSession(sessionId: string): Promise<void>;
};

const pageFileName = (pageVersion: number): string => `page-${pageVersion}.html`;

// 页面正文临时文件存储：目录/文件均为私有权限，写入走临时名 + rename 保证原子性
export const createPageStore = (dir: string): PageStore => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const sessionDir = (sessionId: string): string => join(dir, sessionId);

  const ensureSessionDir = (sessionId: string): string => {
    const target = sessionDir(sessionId);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    chmodSync(target, 0o700);
    return target;
  };

  return {
    dir,
    path: (sessionId, pageVersion) => join(sessionDir(sessionId), pageFileName(pageVersion)),
    write: async (sessionId, pageVersion, html) => {
      const target = join(ensureSessionDir(sessionId), pageFileName(pageVersion));
      const tmp = `${target}.tmp-${crypto.randomUUID()}`;
      writeFileSync(tmp, html, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, target);
      return target;
    },
    exists: (path) => existsSync(path),
    listSessionIds: () =>
      readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("html_"))
        .map((entry) => entry.name),
    removeSession: async (sessionId) => {
      rmSync(sessionDir(sessionId), { recursive: true, force: true });
    },
  };
};

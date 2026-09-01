import type { PathLike } from 'node:fs';
import { createRequire } from 'node:module';

type SqliteModule = typeof import('node:sqlite');

export type ProjectKnowledgeDatabase = import('node:sqlite').DatabaseSync;

const requireModule = createRequire(import.meta.url);
const SQLITE_EXPERIMENTAL_WARNING =
  'SQLite is an experimental feature and might change at any time';

let sqliteModule: SqliteModule | undefined;

function loadSqliteModule(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message = warning instanceof Error ? warning.message : warning;
    if (message.startsWith(SQLITE_EXPERIMENTAL_WARNING)) return;
    Reflect.apply(originalEmitWarning, process, [warning, ...args]);
  }) as typeof process.emitWarning;
  try {
    sqliteModule = requireModule('node:sqlite') as SqliteModule;
    return sqliteModule;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

export function openProjectKnowledgeDatabase(
  databasePath: PathLike,
  options?: import('node:sqlite').DatabaseSyncOptions,
): ProjectKnowledgeDatabase {
  const Database = loadSqliteModule().DatabaseSync;
  return options === undefined ? new Database(databasePath) : new Database(databasePath, options);
}

export async function backupProjectKnowledgeDatabase(
  source: ProjectKnowledgeDatabase,
  destinationPath: PathLike,
): Promise<number> {
  return loadSqliteModule().backup(source, destinationPath);
}

export function projectKnowledgeDatabaseBackupAvailable(): boolean {
  return typeof (loadSqliteModule() as Partial<SqliteModule>).backup === 'function';
}

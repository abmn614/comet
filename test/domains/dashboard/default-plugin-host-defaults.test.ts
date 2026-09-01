import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDefaultCometPluginBridge } from '../../../domains/comet-plugin/index.js';
import { createDefaultDashboardPluginHostFactory } from '../../../domains/dashboard/default-plugin-host.js';
import { ProjectKnowledgeLocalStore } from '../../../domains/project-knowledge/local-store.js';
import { openProjectKnowledgeDatabase } from '../../../domains/project-knowledge/sqlite.js';
import {
  defaultProjectKnowledgeStorageRoot,
  resolveProjectKnowledgeStorageLocation,
} from '../../../platform/paths/project-knowledge-storage.js';
import { resolveStableProjectId } from '../../../platform/paths/project-identity.js';

const projectId = 'project-default-cache';
let isolatedHome: string;
let projectRoot: string;

describe('default dashboard project knowledge cache', () => {
  beforeAll(async () => {
    isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-dashboard-default-home-'));
    projectRoot = path.join(isolatedHome, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(isolatedHome, { recursive: true, force: true });
  });

  it('shares records bidirectionally without either cache path override', async () => {
    const cliBridge = await createDefaultCometPluginBridge({
      projectRoot,
      projectId,
      homeDirectory: isolatedHome,
    });
    await cliBridge.pluginRuntime.invoke(
      'comet.project-knowledge',
      'create',
      {
        type: 'constraint',
        title: 'CLI default cache rule',
        summary: 'The Dashboard reads records created through the CLI default cache.',
      },
      { scope: 'project', projectId },
    );

    const host = await createDefaultDashboardPluginHostFactory({ homeDirectory: isolatedHome })(
      projectId,
      projectRoot,
    );
    await expect(host.get('comet.project-knowledge')).resolves.toMatchObject({
      data: {
        records: [expect.objectContaining({ title: 'CLI default cache rule' })],
      },
    });

    await host.invoke('comet.project-knowledge', 'create', {
      type: 'procedure',
      title: 'Dashboard default cache rule',
      summary: 'The CLI reads records created through the Dashboard default cache.',
    });
    await expect(
      cliBridge.pluginRuntime.invoke(
        'comet.project-knowledge',
        'list',
        { state: 'all' },
        { scope: 'project', projectId },
      ),
    ).resolves.toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({ title: 'CLI default cache rule' }),
        expect.objectContaining({ title: 'Dashboard default cache rule' }),
      ]),
    });
  });

  it('imports records and feedback state from the legacy Dashboard cache', async () => {
    const legacyProjectId = 'project-legacy-cache';
    const recordProjectId = resolveStableProjectId(projectRoot);
    const legacyCacheRoot = path.join(isolatedHome, '.comet', 'plugins', 'knowledge-cache');
    const legacyStore = new ProjectKnowledgeLocalStore({
      projectRoot,
      cacheRoot: legacyCacheRoot,
    });
    const legacyRecord = {
      id: 'legacy-dashboard-record',
      projectId: recordProjectId,
      type: 'fact' as const,
      state: 'trial' as const,
      authority: 'automatic' as const,
      title: 'Legacy Dashboard record',
      summary: 'This record and its feedback state must survive cache migration.',
      applicablePaths: [],
      operations: [],
      phases: [],
      conclusions: [],
      relations: [],
      verification: [],
      sourceVersions: [],
      applicationCount: 0,
      successCount: 0,
      failureCount: 0,
      updatedAt: '2026-08-31T00:00:00.000Z',
    };
    const failedFeedback = {
      kind: 'feedback' as const,
      id: legacyRecord.id,
      projectId: recordProjectId,
      outcome: 'contributed-to-failure' as const,
      applicationId: 'legacy-application',
      revision: 1,
      idempotencyKey: 'legacy-feedback-1',
      updatedAt: '2026-08-31T00:01:00.000Z',
    };
    await legacyStore.apply({ kind: 'upsert', record: legacyRecord });
    await expect(legacyStore.apply(failedFeedback)).resolves.toMatchObject({
      changed: true,
      record: expect.objectContaining({
        state: 'superseded',
        applicationCount: 1,
        failureCount: 1,
      }),
    });
    const legacyDatabasePath = resolveProjectKnowledgeStorageLocation(
      projectRoot,
      legacyCacheRoot,
    ).databasePath;
    const legacyDatabaseBeforeMigration = await fs.readFile(legacyDatabasePath);
    const legacyDirectoryBeforeMigration = await fs.readdir(path.dirname(legacyDatabasePath));
    const legacyMtimeBeforeMigration = (await fs.stat(legacyDatabasePath)).mtimeMs;

    const host = await createDefaultDashboardPluginHostFactory({ homeDirectory: isolatedHome })(
      legacyProjectId,
      projectRoot,
    );
    await expect(host.get('comet.project-knowledge')).resolves.toMatchObject({
      data: {
        records: expect.arrayContaining([
          expect.objectContaining({ title: 'Legacy Dashboard record' }),
        ]),
      },
    });

    const canonicalBridge = await createDefaultCometPluginBridge({
      projectRoot,
      projectId: legacyProjectId,
      homeDirectory: isolatedHome,
    });
    await expect(
      canonicalBridge.pluginRuntime.invoke(
        'comet.project-knowledge',
        'list',
        { state: 'all' },
        { scope: 'project', projectId: legacyProjectId },
      ),
    ).resolves.toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({
          title: 'Legacy Dashboard record',
          state: 'superseded',
          applicationCount: 1,
          failureCount: 1,
        }),
      ]),
    });

    const canonicalStore = new ProjectKnowledgeLocalStore({
      projectRoot,
      cacheRoot: defaultProjectKnowledgeStorageRoot(isolatedHome),
    });
    const canonicalDatabasePath = canonicalStore.databasePath;
    await expect(canonicalStore.apply(failedFeedback)).resolves.toMatchObject({ changed: false });
    await expect(
      canonicalStore.apply({
        ...failedFeedback,
        idempotencyKey: 'legacy-feedback-1-retry',
      }),
    ).resolves.toMatchObject({ changed: false });
    await expect(
      canonicalStore.apply({
        ...failedFeedback,
        outcome: 'used-successfully',
        revision: 2,
        idempotencyKey: 'legacy-feedback-2',
        updatedAt: '2026-08-31T00:02:00.000Z',
      }),
    ).resolves.toMatchObject({
      changed: true,
      record: expect.objectContaining({
        state: 'proven',
        applicationCount: 1,
        successCount: 1,
        failureCount: 0,
      }),
    });
    canonicalStore.close();

    const reopenedHost = await createDefaultDashboardPluginHostFactory({
      homeDirectory: isolatedHome,
    })(legacyProjectId, projectRoot);
    await expect(reopenedHost.get('comet.project-knowledge')).resolves.toBeDefined();
    const canonicalDatabase = openProjectKnowledgeDatabase(canonicalDatabasePath, {
      readOnly: true,
    });
    expect(
      canonicalDatabase.prepare('SELECT COUNT(*) AS count FROM pk_feedback_state').get() as {
        count: number;
      },
    ).toEqual({ count: 0 });
    canonicalDatabase.close();
    await expect(fs.readFile(legacyDatabasePath)).resolves.toEqual(legacyDatabaseBeforeMigration);
    await expect(fs.readdir(path.dirname(legacyDatabasePath))).resolves.toEqual(
      legacyDirectoryBeforeMigration,
    );
    await expect(fs.stat(legacyDatabasePath)).resolves.toMatchObject({
      mtimeMs: legacyMtimeBeforeMigration,
    });
    legacyStore.close();
  });

  it.each(['corrupt', 'incompatible'] as const)(
    'starts when the legacy Dashboard database is %s',
    async (legacyDatabaseKind) => {
      const fallbackProjectRoot = path.join(isolatedHome, `project-${legacyDatabaseKind}`);
      await fs.mkdir(fallbackProjectRoot, { recursive: true });
      const legacyCacheRoot = path.join(isolatedHome, '.comet', 'plugins', 'knowledge-cache');
      const legacyDatabasePath = resolveProjectKnowledgeStorageLocation(
        fallbackProjectRoot,
        legacyCacheRoot,
      ).databasePath;
      await fs.mkdir(path.dirname(legacyDatabasePath), { recursive: true });
      if (legacyDatabaseKind === 'corrupt') {
        await fs.writeFile(legacyDatabasePath, 'not a sqlite database');
      } else {
        const database = openProjectKnowledgeDatabase(legacyDatabasePath);
        database.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY);');
        database.close();
      }

      const host = await createDefaultDashboardPluginHostFactory({
        homeDirectory: isolatedHome,
      })(`${legacyDatabaseKind}-project`, fallbackProjectRoot);
      await expect(host.get('comet.project-knowledge')).resolves.toMatchObject({
        data: { records: [] },
      });
    },
  );

  it('defers malformed or orphaned legacy state without marking migration complete', async () => {
    const malformedProjectRoot = path.join(isolatedHome, 'project-malformed-feedback');
    await fs.mkdir(malformedProjectRoot, { recursive: true });
    const recordProjectId = resolveStableProjectId(malformedProjectRoot);
    const legacyCacheRoot = path.join(isolatedHome, '.comet', 'plugins', 'knowledge-cache');
    const legacyStore = new ProjectKnowledgeLocalStore({
      projectRoot: malformedProjectRoot,
      cacheRoot: legacyCacheRoot,
    });
    const legacyRecord = {
      projectId: recordProjectId,
      type: 'fact' as const,
      state: 'trial' as const,
      authority: 'automatic' as const,
      applicablePaths: [],
      operations: [],
      phases: [],
      conclusions: [],
      relations: [],
      verification: [],
      sourceVersions: [],
      applicationCount: 0,
      successCount: 0,
      failureCount: 0,
      updatedAt: '2026-08-31T00:00:00.000Z',
    };
    await legacyStore.apply({
      kind: 'upsert',
      record: {
        ...legacyRecord,
        id: 'legacy-healthy-record',
        title: 'Healthy legacy record',
        summary: 'A healthy record still migrates when another record has malformed state.',
      },
    });
    await legacyStore.apply({
      kind: 'upsert',
      record: {
        ...legacyRecord,
        id: 'legacy-malformed-record',
        title: 'Malformed legacy record',
        summary: 'This record is excluded together with its malformed auxiliary state.',
      },
    });
    const legacyDatabasePath = legacyStore.databasePath;
    legacyStore.close();

    const legacyDatabase = openProjectKnowledgeDatabase(legacyDatabasePath);
    legacyDatabase
      .prepare('INSERT INTO pk_applied_mutations(mutation_key, applied_at) VALUES (?, ?)')
      .run('learning-delta:valid-mutation', '2026-08-31T00:01:00.000Z');
    legacyDatabase
      .prepare(
        'INSERT INTO pk_application_outcomes(record_id, application_id, status, revision) VALUES (?, ?, ?, ?)',
      )
      .run('legacy-malformed-record', 'invalid-outcome', 'not-an-outcome', -1);
    legacyDatabase
      .prepare('INSERT INTO pk_feedback_state(record_id, base_state) VALUES (?, ?)')
      .run('legacy-malformed-record', 'not-a-state');
    legacyDatabase
      .prepare(
        'INSERT INTO pk_application_outcomes(record_id, application_id, status, revision) VALUES (?, ?, ?, ?)',
      )
      .run('missing-record', 'orphan-outcome', 'used-successfully', 1);
    legacyDatabase.close();
    const legacyDatabaseBeforeMigration = await fs.readFile(legacyDatabasePath);

    const host = await createDefaultDashboardPluginHostFactory({ homeDirectory: isolatedHome })(
      'malformed-feedback-project',
      malformedProjectRoot,
    );
    await expect(host.get('comet.project-knowledge')).resolves.toMatchObject({
      data: { records: [] },
    });

    const canonicalDatabasePath = resolveProjectKnowledgeStorageLocation(
      malformedProjectRoot,
      defaultProjectKnowledgeStorageRoot(isolatedHome),
    ).databasePath;
    const canonicalDatabase = openProjectKnowledgeDatabase(canonicalDatabasePath, {
      readOnly: true,
    });
    expect(
      canonicalDatabase.prepare('SELECT COUNT(*) AS count FROM pk_applied_mutations').get(),
    ).toEqual({ count: 0 });
    expect(
      canonicalDatabase.prepare('SELECT COUNT(*) AS count FROM pk_application_outcomes').get(),
    ).toEqual({ count: 0 });
    expect(
      canonicalDatabase.prepare('SELECT COUNT(*) AS count FROM pk_feedback_state').get(),
    ).toEqual({ count: 0 });
    expect(canonicalDatabase.prepare('SELECT id FROM pk_records ORDER BY id').all()).toEqual([]);
    expect(
      canonicalDatabase
        .prepare("SELECT value FROM pk_meta WHERE key = 'legacy_dashboard_cache_v1'")
        .get(),
    ).toBeUndefined();
    canonicalDatabase.close();
    await expect(fs.readFile(legacyDatabasePath)).resolves.toEqual(legacyDatabaseBeforeMigration);

    const repairedLegacyDatabase = openProjectKnowledgeDatabase(legacyDatabasePath);
    repairedLegacyDatabase.prepare('DELETE FROM pk_application_outcomes').run();
    repairedLegacyDatabase.prepare('DELETE FROM pk_feedback_state').run();
    repairedLegacyDatabase.close();

    const retriedHost = await createDefaultDashboardPluginHostFactory({
      homeDirectory: isolatedHome,
    })('malformed-feedback-project', malformedProjectRoot);
    await expect(retriedHost.get('comet.project-knowledge')).resolves.toMatchObject({
      data: {
        records: expect.arrayContaining([
          expect.objectContaining({ id: 'legacy-healthy-record' }),
          expect.objectContaining({ id: 'legacy-malformed-record' }),
        ]),
      },
    });

    const retriedCanonicalDatabase = openProjectKnowledgeDatabase(canonicalDatabasePath, {
      readOnly: true,
    });
    expect(retriedCanonicalDatabase.prepare('SELECT id FROM pk_records ORDER BY id').all()).toEqual(
      [{ id: 'legacy-healthy-record' }, { id: 'legacy-malformed-record' }],
    );
    expect(
      retriedCanonicalDatabase.prepare('SELECT mutation_key FROM pk_applied_mutations').all(),
    ).toEqual([{ mutation_key: 'learning-delta:valid-mutation' }]);
    retriedCanonicalDatabase.close();
  });
});

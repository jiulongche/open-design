import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveDesignSystemIntent } from '@open-design/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { readDesignSystemRuntime } from '../../src/design-systems/index.js';

const fixturesRoot = path.resolve(import.meta.dirname, '../fixtures/design-systems');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('design-system structured runtime', () => {
  it('loads component, intent, lint, and fallback files and resolves a structured selection', async () => {
    const result = await readDesignSystemRuntime(fixturesRoot, 'runtime-v3');

    expect(result.mode).toBe('structured');
    if (result.mode !== 'structured') return;
    expect(result.bundle.components.map((component) => component.definition.id)).toEqual(['Button']);
    expect(result.bundle.lint.requireDeclaredStates).toBe(true);
    expect(result.bundle.fallback.noMatch.allowInventComponent).toBe(false);

    const resolution = resolveDesignSystemIntent(result.bundle, 'account.settings.save');
    expect(resolution).toMatchObject({
      status: 'matched',
      matches: [{
        component: { id: 'Button', selectors: ['.button'] },
        variant: { id: 'primary', selectors: ['.button--primary'] },
        properties: { label: 'Save changes', disabled: false },
        states: [
          { id: 'hover', selectors: ['.button--primary:hover'], required: true },
          { id: 'focus', selectors: ['.button:focus-visible'], required: true },
        ],
      }],
    });
  });

  it('keeps manifest-free packages on the legacy path', async () => {
    await expect(readDesignSystemRuntime(fixturesRoot, 'legacy')).resolves.toEqual({ mode: 'legacy' });
  });

  it('reports dangling intent references instead of silently falling back', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-ds-runtime-'));
    temporaryRoots.push(root);
    const packageRoot = path.join(root, 'runtime-v3');
    await cp(path.join(fixturesRoot, 'runtime-v3'), packageRoot, { recursive: true });
    const intentPath = path.join(packageRoot, 'manifests', 'intent-map.json');
    const intent = JSON.parse(await readFile(intentPath, 'utf8')) as {
      mappings: Array<{ component: string }>;
    };
    intent.mappings[0]!.component = 'MissingButton';
    await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`);

    const result = await readDesignSystemRuntime(root, 'runtime-v3');

    expect(result.mode).toBe('invalid');
    if (result.mode !== 'invalid') return;
    expect(result.errors).toContain(
      'intent mapping account.settings.save at index 0 references unknown component MissingButton',
    );
  });

  it('does not downgrade a declared but malformed runtime to the legacy path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-ds-runtime-manifest-'));
    temporaryRoots.push(root);
    const packageRoot = path.join(root, 'runtime-v3');
    await cp(path.join(fixturesRoot, 'runtime-v3'), packageRoot, { recursive: true });
    const manifestPath = path.join(packageRoot, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      runtime: { components: string };
    };
    manifest.runtime.components = '../components.json';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = await readDesignSystemRuntime(root, 'runtime-v3');

    expect(result.mode).toBe('invalid');
    if (result.mode !== 'invalid') return;
    expect(result.errors.join('\n')).toContain('manifest.json: $.runtime.components');
  });

  it.runIf(process.platform !== 'win32')('rejects runtime files that escape through a symbolic link', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-ds-runtime-symlink-'));
    temporaryRoots.push(root);
    const packageRoot = path.join(root, 'runtime-v3');
    await cp(path.join(fixturesRoot, 'runtime-v3'), packageRoot, { recursive: true });
    const externalPath = path.join(root, 'external-components.json');
    await writeFile(externalPath, JSON.stringify({ schemaVersion: 'od-design-system-components/v1', components: [] }));
    const componentsPath = path.join(packageRoot, 'manifests', 'components.json');
    await rm(componentsPath);
    await symlink(externalPath, componentsPath);

    const result = await readDesignSystemRuntime(root, 'runtime-v3');

    expect(result.mode).toBe('invalid');
    if (result.mode !== 'invalid') return;
    expect(result.errors).toContain(
      'manifests/components.json: path resolves outside the design-system package root',
    );
  });
});

// Runnable check for lang.ts: `npm run check`. Builds a tiny monorepo in a temp dir, where two
// packages map the same alias to different folders and one maps a package to a `dist/` that was never
// built, then asserts definitions and references land where an editor would, and that hover names a
// package whose types are not installed and a signature this PR changed.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Lang } from './lang.js';

const files: Record<string, string> = {
  'packages/app/package.json': '{ "name": "@demo/app" }',
  'packages/app/jsconfig.json': '{ "compilerOptions": { "baseUrl": "./", "paths": { "hooks/*": ["src/hooks/*"] } } }',
  'packages/app/src/hooks/useThing/index.js': 'export default function useThing(a) { return a; }\n',
  'packages/app/src/components/Panel.js': "import useThing from 'hooks/useThing';\nuseThing(1);\n",
  'packages/app/src/view.js': "import { useState } from 'react';\nexport function show(a, b) { return useState(a + b); }\n",
  'packages/web/package.json': '{ "name": "@demo/web" }',
  'packages/web/tsconfig.json': '{ "compilerOptions": { "baseUrl": "./", "paths": { "hooks/*": ["lib/hooks/*"], "@demo/types": ["../types/dist/index.d.ts"] } }, "include": ["lib/**/*.ts"] }',
  'packages/web/lib/hooks/useThing/index.ts': 'export default function useThing(): string { return ""; }\n',
  'packages/web/lib/page.ts': "import useThing from 'hooks/useThing';\nimport type { Shape } from '@demo/types';\nexport const s: Shape = { n: useThing().length };\n",
  'packages/types/package.json': '{ "name": "@demo/types", "types": "dist/index.d.ts" }',
  'packages/types/src/index.ts': 'export interface Shape { n: number }\n'
};

const dir = mkdtempSync(join(tmpdir(), 'doubt-lang-'));
try {
  for (const [p, text] of Object.entries(files)) { mkdirSync(join(dir, dirname(p)), { recursive: true }); writeFileSync(join(dir, p), text); }
  const lang = new Lang(dir, Object.keys(files));
  const at = (path: string, line: number, word: string) => files[path].split('\n')[line - 1].indexOf(word) + 1;
  const where = (locs: { path: string; line: number }[]) => locs.map((l) => `${l.path}:${l.line}`);

  // the app's alias resolves through its jsconfig
  assert.deepEqual(where(lang.definitions('packages/app/src/components/Panel.js', 2, at('packages/app/src/components/Panel.js', 2, 'useThing'))), ['packages/app/src/hooks/useThing/index.js:1']);
  // references cross the alias, and stay inside the app's project
  assert.deepEqual(new Set(lang.references('packages/app/src/hooks/useThing/index.js', 1, at('packages/app/src/hooks/useThing/index.js', 1, 'useThing')).map((l) => l.path)),
    new Set(['packages/app/src/hooks/useThing/index.js', 'packages/app/src/components/Panel.js']));
  // the same alias in another package means that package's folder
  assert.deepEqual(where(lang.definitions('packages/web/lib/page.ts', 1, at('packages/web/lib/page.ts', 1, 'useThing'))), ['packages/web/lib/hooks/useThing/index.ts:1']);
  // a mapping to an unbuilt dist/ falls back to the package's source
  assert.deepEqual(where(lang.definitions('packages/web/lib/page.ts', 3, at('packages/web/lib/page.ts', 3, 'Shape'))), ['packages/types/src/index.ts:1']);
  // hover: a package that does not resolve here is named as one; a signature changed since the base shows both
  lang.setBase(new Map([[join(dir, 'packages/app/src/view.js'), "import { useState } from 'react';\nexport function show(a) { return useState(a); }\n"]]));
  assert.equal(lang.hover('packages/app/src/view.js', 2, at('packages/app/src/view.js', 2, 'useState'))?.lib, 'react');
  const show = lang.hover('packages/app/src/view.js', 2, at('packages/app/src/view.js', 2, 'show'));
  assert.match(show?.sig ?? '', /show\(a: any, b: any\)/);
  assert.match(show?.before ?? '', /show\(a: any\)/);
  assert.equal(lang.hover('packages/app/src/hooks/useThing/index.js', 1, at('packages/app/src/hooks/useThing/index.js', 1, 'useThing'))?.before, undefined); // unchanged: no "before"
  console.log('lang: ok');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

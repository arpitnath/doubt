// Code intelligence over a PR checkout, px0's LSP layer in miniature. Like an editor, each file
// belongs to the nearest tsconfig.json or jsconfig.json above it and gets that project's options
// (aliases, baseUrl, jsx); files with none share one default project. Projects are built lazily.
// Workspace packages resolve by name in every project. Other languages get nothing here yet.
import ts from 'ts5';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';

export interface Loc { path: string; line: number; col: number; text?: string }

// What a reviewer sees hovering a name: TypeScript's own answers, nothing inferred.
export interface Hover {
  sig: string;
  doc: string;
  def?: Loc; // where it is declared, inside the checkout
  builtIn: boolean; // declared by JavaScript or the browser (TypeScript's lib files)
  lib?: string; // imported from a package that does not resolve in the checkout: its types are not installed
  refs: string[]; // files that use it
  before?: string; // its signature at the PR's base, when this PR changed it
}

const SCRIPT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP = /(^|\/)(node_modules|dist|build|coverage|\.next|out)\//;
const CONFIG = /(^|\/)(tsconfig|jsconfig)\.json$/;

const DEFAULTS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.Preserve,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
  resolveJsonModule: true
};

interface Project { service: ts.LanguageService; files: Set<string>; config: string; options: ts.CompilerOptions }

export class Lang {
  private texts = new Map<string, string>(); // the checkout never changes under a Lang; read each file once
  private registry = ts.createDocumentRegistry(); // projects share parsed files
  private projects = new Map<string, Project>(); // config path, or '' for the default project
  private configs: Set<string>;
  private names: string[];
  private workspace: Record<string, string[]>;
  private base: Map<string, string> | null = null; // absolute path -> text at the PR base, for files this PR changes

  constructor(private dir: string, treePaths: string[]) {
    this.names = treePaths.filter((p) => SCRIPT.test(p) && !SKIP.test(p)).map((p) => join(dir, p));
    this.configs = new Set(treePaths.filter((p) => CONFIG.test(p) && !SKIP.test(p)));
    this.workspace = workspacePaths(dir, treePaths);
  }

  private read(f: string): string | undefined {
    const have = this.texts.get(f);
    if (have !== undefined) return have;
    if (!existsSync(f) || !statSync(f).isFile()) return undefined;
    const text = readFileSync(f, 'utf8');
    this.texts.set(f, text);
    return text;
  }

  // The nearest config above the file, tsconfig.json first; '' when there is none, or when the
  // config does not include the file (an editor puts such a file in an inferred project too).
  private projectFor(path: string): Project {
    for (let d = dirname(path); ; d = dirname(d)) {
      const config = ['tsconfig.json', 'jsconfig.json'].map((n) => (d === '.' ? n : `${d}/${n}`)).find((c) => this.configs.has(c));
      if (config) {
        const p = this.project(config);
        if (p.files.has(join(this.dir, path))) return p;
        break;
      }
      if (d === '.' || d === '/') break;
    }
    return this.project('');
  }

  // build the project a file belongs to now (and its base twin, once the base texts are set), so the
  // first hover or jump in it is not the slow one
  warm(path: string, atBase = false): void {
    const p = this.projectFor(path);
    (atBase ? this.project(p.config, true) : p).service.getProgram();
  }

  // the PR base's version of the files this PR changes, for signatures before and after
  setBase(texts: Map<string, string>): void {
    this.base = texts;
  }

  private project(config: string, atBase = false): Project {
    const key = atBase ? `${config}@base` : config;
    const have = this.projects.get(key);
    if (have) return have;
    let options: ts.CompilerOptions = { ...DEFAULTS, baseUrl: this.dir, paths: this.workspace };
    let names = this.names;
    if (config) {
      const abs = join(this.dir, config);
      const { config: json, error } = ts.readConfigFile(abs, (f) => this.read(f));
      if (error) { // unreadable config: its files get the default project, once
        const fallback = this.project('', atBase);
        this.projects.set(key, fallback);
        return fallback;
      }
      // allowJs so a tsconfig's include picks up .js; jsconfig.json already implies it
      const parsed = ts.parseJsonConfigFileContent(json, ts.sys, dirname(abs), { allowJs: true }, abs);
      // The project's own aliases come first. TypeScript tries an alias's targets in order, so the
      // workspace source dir follows as a fallback: a project mapping a package to its built `dist/`
      // still resolves in a checkout that never ran a build. Absolute, so any baseUrl works.
      const paths: ts.MapLike<string[]> = { ...this.workspace };
      for (const [alias, targets] of Object.entries(parsed.options.paths ?? {})) paths[alias] = [...targets, ...(this.workspace[alias] ?? [])];
      options = { ...DEFAULTS, ...parsed.options, noEmit: true, paths };
      names = parsed.fileNames.filter((f) => SCRIPT.test(f) && !SKIP.test(f));
    }
    // at the base, files this PR changes read as they were; everything else is the same at both revisions
    const read = atBase && this.base ? (f: string) => this.base!.get(f) ?? this.read(f) : (f: string) => this.read(f);
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => names,
      getScriptVersion: () => '1',
      getScriptSnapshot: (f) => { const t = read(f); return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t); },
      getCurrentDirectory: () => this.dir,
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => existsSync(f),
      readFile: (f) => read(f),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories
    };
    // the base twin gets its own registry: the same file name holds different text at the two revisions
    const p = { service: ts.createLanguageService(host, atBase ? ts.createDocumentRegistry() : this.registry), files: new Set(names), config, options };
    this.projects.set(key, p);
    return p;
  }

  private offset(service: ts.LanguageService, path: string, line: number, col: number): { file: string; pos: number } | null {
    const file = join(this.dir, path);
    const text = service.getProgram()?.getSourceFile(file)?.text ?? this.read(file);
    if (text === undefined) return null;
    let pos = 0;
    for (let i = 1; i < line; i++) { const nl = text.indexOf('\n', pos); if (nl < 0) return null; pos = nl + 1; }
    return { file, pos: pos + Math.max(0, col) };
  }

  private toLoc(service: ts.LanguageService, fileName: string, span: ts.TextSpan): Loc | null {
    const rel = relative(this.dir, resolve(fileName));
    if (rel.startsWith('..') || fileName.includes('/node_modules/typescript/')) return null; // outside the checkout, e.g. lib.d.ts
    const sf = service.getProgram()?.getSourceFile(fileName);
    if (!sf) return null;
    const lc = sf.getLineAndCharacterOfPosition(span.start);
    const lineText = sf.text.split('\n')[lc.line] ?? '';
    return { path: rel, line: lc.line + 1, col: lc.character, text: lineText.trim().slice(0, 160) };
  }

  definitions(path: string, line: number, col: number): Loc[] {
    const { service } = this.projectFor(path);
    const at = this.offset(service, path, line, col);
    if (!at) return [];
    const defs = service.getDefinitionAtPosition(at.file, at.pos) ?? [];
    return dedupe(defs.map((d) => this.toLoc(service, d.fileName, d.textSpan)));
  }

  hover(path: string, line: number, col: number): Hover | null {
    const project = this.projectFor(path);
    const { service } = project;
    const at = this.offset(service, path, line, col);
    if (!at) return null;
    const qi = service.getQuickInfoAtPosition(at.file, at.pos);
    if (!qi) return null; // a keyword, a string, a comment
    const sig = ts.displayPartsToString(qi.displayParts);
    const name = service.getProgram()?.getSourceFile(at.file)?.text.slice(qi.textSpan.start, qi.textSpan.start + qi.textSpan.length) ?? '';
    const d0 = (service.getDefinitionAtPosition(at.file, at.pos) ?? [])[0];
    const builtIn = !!d0 && /\/node_modules\/(typescript|ts5)\/lib\//.test(d0.fileName);
    const def = d0 && !builtIn ? this.toLoc(service, d0.fileName, d0.textSpan) ?? undefined : undefined;
    const refs = builtIn ? [] : [...new Set((service.getReferencesAtPosition(at.file, at.pos) ?? []).map((r) => relative(this.dir, resolve(r.fileName))).filter((f) => !f.startsWith('..')))];
    const lib = d0 && !builtIn ? this.library(project, d0) : undefined;
    const before = def && def.path === path ? this.signatureAtBase(project, at.file, name, sig) : undefined;
    return { sig, doc: ts.displayPartsToString(qi.documentation), def, builtIn, lib, refs, before };
  }

  // A name bound by `import ... from 'x'` or `require('x')`, where x does not resolve to a file in the
  // checkout: a package whose types are not installed here.
  private library(project: Project, def: ts.DefinitionInfo): string | undefined {
    const sf = project.service.getProgram()?.getSourceFile(def.fileName);
    if (!sf) return undefined;
    let spec: string | undefined;
    for (let n: ts.Node | undefined = nodeAt(sf, def.textSpan.start); n && !spec; n = n.parent) {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) spec = n.moduleSpecifier.text;
      else if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression)
        && n.initializer.expression.text === 'require' && n.initializer.arguments[0] && ts.isStringLiteral(n.initializer.arguments[0])) spec = n.initializer.arguments[0].text;
    }
    if (!spec || spec.startsWith('.')) return undefined;
    const resolved = ts.resolveModuleName(spec, def.fileName, project.options, ts.sys).resolvedModule;
    return !resolved || resolved.isExternalLibraryImport ? spec : undefined;
  }

  // The same declaration in the base version of the file, found in its syntax tree; its signature
  // when it differs from the head's.
  private signatureAtBase(project: Project, file: string, name: string, headSig: string): string | undefined {
    if (!this.base?.has(file) || !name) return undefined;
    const baseProject = this.project(project.config, true);
    const sf = baseProject.service.getProgram()?.getSourceFile(file);
    const decl = sf && declarationNamed(sf, name);
    if (!decl) return undefined; // new in this PR
    const sig = ts.displayPartsToString(baseProject.service.getQuickInfoAtPosition(file, decl.getStart(sf))?.displayParts);
    return sig && sig.replace(/\s+/g, ' ') !== headSig.replace(/\s+/g, ' ') ? sig : undefined;
  }

  references(path: string, line: number, col: number): Loc[] {
    const { service } = this.projectFor(path);
    const at = this.offset(service, path, line, col);
    if (!at) return [];
    const refs = service.getReferencesAtPosition(at.file, at.pos) ?? [];
    return dedupe(refs.map((r) => this.toLoc(service, r.fileName, r.textSpan)));
  }
}

// the innermost node spanning a position
function nodeAt(sf: ts.SourceFile, pos: number): ts.Node | undefined {
  const inside = (n: ts.Node): ts.Node | undefined => ts.forEachChild(n, (c) => (c.getStart(sf) <= pos && pos < c.getEnd() ? inside(c) ?? c : undefined));
  return inside(sf);
}

// the first declaration (function, variable, class, method, parameter, property, type) with this name
function declarationNamed(sf: ts.SourceFile, name: string): ts.Identifier | undefined {
  const visit = (n: ts.Node): ts.Identifier | undefined => {
    const id = (n as ts.Node & { name?: ts.Node }).name;
    if (id && ts.isIdentifier(id) && id.text === name && (ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n) || ts.isClassDeclaration(n)
      || ts.isMethodDeclaration(n) || ts.isParameter(n) || ts.isPropertyDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n))) return id;
    return ts.forEachChild(n, visit);
  };
  return visit(sf);
}

function dedupe(locs: Array<Loc | null>): Loc[] {
  const seen = new Set<string>();
  const out: Loc[] = [];
  for (const l of locs) {
    if (!l) continue;
    const k = `${l.path}:${l.line}:${l.col}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out.slice(0, 200);
}

// ponytail: workspace packages by name -> their source dir, from every package.json in the tree.
// Enough for `import x from '@scope/pkg'` in a monorepo; no exports-map parsing. Absolute paths,
// so the mapping holds whatever baseUrl a project sets.
function workspacePaths(dir: string, treePaths: string[]): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const p of treePaths) {
    if (!p.endsWith('/package.json') || SKIP.test(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(dir, p), 'utf8')) as { name?: string; main?: string; source?: string; types?: string };
      if (!pkg.name) continue;
      const pkgDir = join(dir, dirname(p));
      const entry = [pkg.source, pkg.types, 'src/index.ts', 'src/index.tsx', 'src/index.js', 'index.ts', 'index.js', pkg.main]
        .filter((e): e is string => !!e)
        .map((e) => e.replace(/\.(js|cjs|mjs)$/, ''))
        .find((e) => ['', '.ts', '.tsx', '.js', '.jsx', '.d.ts'].some((ext) => existsSync(join(pkgDir, e + ext))));
      if (entry) paths[pkg.name] = [join(pkgDir, entry)];
      paths[`${pkg.name}/*`] = [join(pkgDir, 'src', '*'), join(pkgDir, '*')];
    } catch { /* not a readable package.json */ }
  }
  return paths;
}

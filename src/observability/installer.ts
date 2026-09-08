import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import {
  COMPONENTS,
  getComponent,
  type ComponentDefinition,
  type ComponentId,
} from "./manifest.js";

export interface InstalledComponent {
  id: ComponentId;
  executable: string;
  home: string;
  version: string;
}

const RECEIPT = ".jarvis-receipt.json";
const MAX_FILES = 50_000;
const MAX_UNPACKED_BYTES = 3 * 1024 ** 3;
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const entrySchema = z
  .object({
    path: z.string().min(1).max(1024),
    size: z.number().int().nonnegative().max(MAX_UNPACKED_BYTES),
    sha256: shaSchema,
  })
  .strict();
const entriesSchema = z.array(entrySchema).min(1).max(MAX_FILES);
type FileEntry = z.infer<typeof entrySchema>;
const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string(),
    version: z.string(),
    archiveSha256: shaSchema,
    treeSha256: shaSchema,
    files: entriesSchema,
  })
  .strict();

/** Pure layout helper. Calling this does not imply the component is installed. */
export function componentPaths(
  projectDir: string,
  id: ComponentId,
): InstalledComponent {
  return pathsFor(projectDir, getComponent(id));
}

function pathsFor(
  projectDir: string,
  component: ComponentDefinition,
): InstalledComponent {
  const home = resolve(
    projectDir,
    ".data",
    "observability",
    "bin",
    component.id,
    component.version,
  );
  return {
    id: component.id,
    version: component.version,
    home,
    executable: join(home, component.executablePath),
  };
}

function safeRelative(path: string): void {
  if (
    !path ||
    path.length > 1024 ||
    path.startsWith("/") ||
    /[\\:\u0000-\u001f\u007f]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    path === RECEIPT
  )
    throw new Error("Niebezpieczna ścieżka w komponencie observability.");
}

function assertDirectory(path: string): void {
  const state = lstatSync(path);
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    (state.mode & 0o022) !== 0 ||
    (process.getuid && state.uid !== process.getuid())
  )
    throw new Error("Niebezpieczny katalog observability.");
}

function prepareRoot(projectDir: string, create: boolean): string {
  const root = realpathSync(resolve(projectDir));
  if (!lstatSync(root).isDirectory())
    throw new Error("Nieprawidłowy katalog projektu.");
  let current = root;
  for (const part of create
    ? [".data", "observability", "bin", "cache"]
    : [".data", "observability", "bin"]) {
    // bin and cache are siblings, not a chain.
    current =
      part === "cache"
        ? join(root, ".data", "observability", "cache")
        : join(current, part);
    if (create && !existsSync(current)) mkdirSync(current, { mode: 0o700 });
    assertDirectory(current);
    if (create) chmodSync(current, 0o700);
  }
  return root;
}

function ensureChildDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  assertDirectory(path);
}

function fileHash(
  path: string,
  maxBytes = MAX_UNPACKED_BYTES,
): { sha256: string; size: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > maxBytes ||
      (before.mode & 0o022) !== 0 ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw new Error("Niebezpieczny plik observability.");
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      if (bytes > maxBytes)
        throw new Error("Przekroczony limit pliku observability.");
      digest.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (
      bytes !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("Plik observability zmienił się podczas weryfikacji.");
    return { sha256: digest.digest("hex"), size: bytes };
  } finally {
    closeSync(fd);
  }
}

function durableDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function treeHash(files: FileEntry[]): string {
  return hash(JSON.stringify(files));
}

function inventory(home: string): FileEntry[] {
  const entries: FileEntry[] = [];
  let total = 0;
  const visit = (dir: string) => {
    assertDirectory(dir);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const relative = path
        .slice(home.length + 1)
        .split(sep)
        .join("/");
      if (relative === RECEIPT) continue;
      safeRelative(relative);
      const state = lstatSync(path);
      if (state.isDirectory()) visit(path);
      else {
        if (
          !state.isFile() ||
          state.isSymbolicLink() ||
          (state.mode & 0o222) !== 0
        )
          throw new Error("Zmienione prawa lub typ pliku komponentu.");
        const digest = fileHash(path);
        total += digest.size;
        if (entries.length >= MAX_FILES || total > MAX_UNPACKED_BYTES)
          throw new Error("Przekroczony limit komponentu observability.");
        entries.push({
          path: relative,
          size: digest.size,
          sha256: digest.sha256,
        });
      }
    }
  };
  visit(home);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

function installed(
  projectDir: string,
  component: ComponentDefinition,
): InstalledComponent {
  const root = prepareRoot(projectDir, false);
  const paths = pathsFor(root, component);
  assertDirectory(dirname(paths.home));
  assertDirectory(paths.home);
  const receiptPath = join(paths.home, RECEIPT);
  fileHash(receiptPath, 16 * 1024 ** 2);
  const receipt = receiptSchema.parse(
    JSON.parse(readFileSync(receiptPath, "utf8")),
  );
  if (
    receipt.id !== component.id ||
    receipt.version !== component.version ||
    receipt.archiveSha256 !== component.sha256 ||
    receipt.treeSha256 !== component.treeSha256 ||
    treeHash(receipt.files) !== component.treeSha256
  )
    throw new Error("Receipt komponentu nie odpowiada przypiętemu wydaniu.");
  for (const entry of receipt.files) safeRelative(entry.path);
  const actual = inventory(paths.home);
  if (treeHash(actual) !== component.treeSha256)
    throw new Error(
      "Integralność plików komponentu observability została naruszona.",
    );
  if (
    !actual.some((entry) => entry.path === component.executablePath) ||
    (lstatSync(paths.executable).mode & 0o100) === 0
  )
    throw new Error("Brak zweryfikowanego pliku wykonywalnego komponentu.");
  return paths;
}

/** Verifies the complete immutable distribution, including Grafana assets. */
export function getInstalledComponent(
  projectDir: string,
  id: ComponentId,
): InstalledComponent {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Manifest observability obsługuje macOS arm64.");
  return installed(projectDir, getComponent(id));
}

const DOWNLOAD_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "dl.grafana.com",
]);
function downloadUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !DOWNLOAD_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new Error("Niedozwolone źródło komponentu observability.");
  return url;
}

async function download(
  component: ComponentDefinition,
  destination: string,
): Promise<void> {
  let url = downloadUrl(component.url);
  const signal = AbortSignal.timeout(180_000);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetch(url, {
      redirect: "manual",
      signal,
      headers: { "User-Agent": "JARVIS-local-component-installer" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 5)
        throw new Error("Nieprawidłowe przekierowanie pobierania komponentu.");
      url = downloadUrl(new URL(location, url).href);
      continue;
    }
    break;
  }
  if (!response?.ok || !response.body)
    throw new Error("Nie udało się pobrać oficjalnego komponentu.");
  const fd = openSync(
    destination,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > component.archiveBytes) {
        throw new Error("Rozmiar pobrania przekracza przypięty manifest.");
      }
      writeFileSync(fd, chunk);
    }
    if (bytes !== component.archiveBytes)
      throw new Error("Niekompletne archiwum komponentu.");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Use Python's maintained archive readers, but never extractall/tar commands.
// Validate every member before writing; reject links, special files, traversal,
// ambiguous case/Unicode paths, duplicate names and oversized distributions.
// -I isolates Python from project imports and PYTHON* environment overrides.
const EXTRACT = String.raw`
import sys, os, json, tarfile, zipfile, stat, hashlib, unicodedata
archive_path, target, kind, strip_text, executable = sys.argv[1:]
strip = int(strip_text)
MAX_FILES = 50000
MAX_BYTES = 3 * 1024 ** 3
def fail(): raise ValueError("unsafe archive")
def parts(name):
    if not name or name.startswith('/') or '\\' in name or ':' in name or any(ord(c)<32 or ord(c)==127 for c in name): fail()
    raw=name.rstrip('/').split('/')
    if any(p in ('', '..') for p in raw): fail()
    while raw and raw[0]=='.': raw.pop(0)
    if any(p=='.' for p in raw): fail()
    return raw
handle = zipfile.ZipFile(archive_path) if kind=='zip' else tarfile.open(archive_path, 'r:gz')
try:
    members=[]; identities={}; spellings={}; root=None; total=0
    source=handle.infolist() if kind=='zip' else handle
    for member in source:
        if len(members)>=MAX_FILES: fail()
        name=member.filename if kind=='zip' else member.name
        raw=parts(name)
        directory=member.is_dir() if kind=='zip' else member.isdir()
        if kind=='zip':
            mode=member.external_attr>>16
            if (member.flag_bits & 1) or (stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR)) or member.compress_type not in (0,8): fail()
            size=member.file_size
        else:
            if not (member.isfile() or directory): fail()
            if getattr(member,'sparse',None): fail()
            mode=member.mode; size=member.size
        if strip:
            if not raw: continue
            if root is None: root=raw[0]
            if root!=raw[0]: fail()
        relative='/'.join(raw[strip:])
        if not relative:
            if not directory: fail()
            continue
        if len(relative)>1024 or relative=='.jarvis-receipt.json': fail()
        segments=relative.split('/')
        for count in range(1,len(segments)+1):
            prefix='/'.join(segments[:count])
            key=unicodedata.normalize('NFC',prefix).casefold()
            if key in spellings and spellings[key]!=prefix: fail()
            spellings[key]=prefix
        identity=unicodedata.normalize('NFC',relative).casefold()
        if identity in identities: fail()
        identities[identity]=directory
        if size<0 or size>MAX_BYTES: fail()
        if not directory: total+=size
        if total>MAX_BYTES: fail()
        members.append((member,relative,directory,size,mode))
    for _,relative,_,_,_ in members:
        parents=relative.split('/')[:-1]
        for count in range(1,len(parents)+1):
            key=unicodedata.normalize('NFC','/'.join(parents[:count])).casefold()
            if identities.get(key) is False: fail()
    result=[]
    for member,relative,directory,size,mode in members:
        destination=os.path.join(target,*relative.split('/'))
        if directory:
            os.makedirs(destination,mode=0o700,exist_ok=True); continue
        os.makedirs(os.path.dirname(destination),mode=0o700,exist_ok=True)
        source=handle.open(member) if kind=='zip' else handle.extractfile(member)
        digest=hashlib.sha256(); copied=0
        with source, open(destination,'xb') as out:
            while True:
                chunk=source.read(1024*1024)
                if not chunk: break
                copied+=len(chunk)
                if copied>size: fail()
                digest.update(chunk); out.write(chunk)
            if copied!=size: fail()
            out.flush(); os.fsync(out.fileno())
        os.chmod(destination,0o555 if relative==executable or mode & 0o111 else 0o444)
        result.append({'path':relative,'size':size,'sha256':digest.hexdigest()})
    if not result: fail()
    result.sort(key=lambda value:value['path'])
    print(json.dumps(result,ensure_ascii=False,separators=(',',':')))
finally: handle.close()
`;

async function extract(
  archive: string,
  staging: string,
  component: ComponentDefinition,
): Promise<FileEntry[]> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      "python3",
      [
        "-I",
        "-c",
        EXTRACT,
        archive,
        staging,
        component.archiveType,
        String(component.stripComponents),
        component.executablePath,
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
        signal: AbortSignal.timeout(180_000),
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8" },
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024 ** 2) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.on("error", () =>
      reject(
        new Error("Nie uruchomiono bezpiecznego czytnika archiwów Python 3."),
      ),
    );
    child.on("close", (code) => {
      if (code !== 0 || size > 16 * 1024 ** 2) {
        reject(new Error("Archiwum odrzucone przez bezpieczny instalator."));
        return;
      }
      try {
        resolveResult(
          entriesSchema.parse(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          ),
        );
      } catch {
        reject(new Error("Nieprawidłowy manifest rozpakowanych plików."));
      }
    });
  });
}

type Downloader = (
  component: ComponentDefinition,
  destination: string,
) => Promise<void>;

async function install(
  projectDir: string,
  components: readonly ComponentDefinition[],
  downloader: Downloader,
): Promise<InstalledComponent[]> {
  const root = prepareRoot(projectDir, true);
  const cacheDir = join(root, ".data", "observability", "cache");
  const result: InstalledComponent[] = [];
  for (const component of components) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(component.id) ||
      !/^\d+\.\d+\.\d+$/.test(component.version) ||
      basename(component.archiveName) !== component.archiveName
    )
      throw new Error("Nieprawidłowy przypięty manifest komponentu.");
    shaSchema.parse(component.sha256);
    shaSchema.parse(component.treeSha256);
    safeRelative(component.executablePath);
    const paths = pathsFor(root, component);
    ensureChildDirectory(dirname(paths.home));
    if (existsSync(paths.home)) {
      result.push(installed(root, component));
      continue;
    }
    const archive = join(
      cacheDir,
      `${component.sha256}-${component.archiveName}`,
    );
    const temporaryDownload = join(
      cacheDir,
      `.download-${component.id}-${randomUUID()}`,
    );
    if (!existsSync(archive)) {
      try {
        await downloader(component, temporaryDownload);
        const verified = fileHash(temporaryDownload, component.archiveBytes);
        if (
          verified.sha256 !== component.sha256 ||
          verified.size !== component.archiveBytes
        )
          throw new Error(
            "SHA-256 pobranego archiwum nie pasuje do oficjalnego wydania.",
          );
        renameSync(temporaryDownload, archive);
        durableDirectory(cacheDir);
      } finally {
        rmSync(temporaryDownload, { force: true });
      }
    }
    const cached = fileHash(archive, component.archiveBytes);
    if (
      cached.sha256 !== component.sha256 ||
      cached.size !== component.archiveBytes
    )
      throw new Error("Naruszona integralność archiwum w cache.");
    const staging = join(
      dirname(paths.home),
      `.staging-${component.version}-${randomUUID()}`,
    );
    mkdirSync(staging, { mode: 0o700 });
    try {
      const files = await extract(archive, staging, component);
      if (
        treeHash(files) !== component.treeSha256 ||
        !files.some((entry) => entry.path === component.executablePath)
      )
        throw new Error(
          "Zawartość archiwum nie odpowiada przypiętemu manifestowi plików.",
        );
      const receipt = {
        schemaVersion: 1,
        id: component.id,
        version: component.version,
        archiveSha256: component.sha256,
        treeSha256: component.treeSha256,
        files,
      };
      const fd = openSync(
        join(staging, RECEIPT),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o400,
      );
      try {
        writeFileSync(fd, JSON.stringify(receipt));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // Persist every directory entry before publishing one complete version.
      const syncTree = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const child = join(dir, name);
          if (lstatSync(child).isDirectory()) syncTree(child);
        }
        durableDirectory(dir);
      };
      syncTree(staging);
      try {
        renameSync(staging, paths.home);
      } catch (error) {
        if (!existsSync(paths.home)) throw error;
        installed(root, component);
      }
      durableDirectory(dirname(paths.home));
      result.push(installed(root, component));
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return result;
}

/** Explicit installation only; ordinary startup never downloads code. */
export async function installComponents(
  projectDir: string,
): Promise<InstalledComponent[]> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Manifest observability obsługuje macOS arm64.");
  return install(projectDir, COMPONENTS, download);
}

/** Deliberate portable test seam; never selected by CLI, environment or HTTP. */
export function createInstallerForTest(
  components: readonly ComponentDefinition[],
  downloader: Downloader = download,
) {
  return {
    installComponents: (projectDir: string) =>
      install(projectDir, components, downloader),
    getInstalledComponent: (projectDir: string, id: ComponentId) => {
      const component = components.find((entry) => entry.id === id);
      if (!component) throw new Error("Nieznany komponent testowy.");
      return installed(projectDir, component);
    },
  };
}

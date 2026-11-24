import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const PACKAGE_MANAGED = ["/usr/", "/opt/", "/nix/", "/snap/", "/home/linuxbrew/"];

export type Executable = { path: string; compiled: boolean };

export function binDir(home: string, env: NodeJS.ProcessEnv) {
  const configured = env.XDG_BIN_HOME?.trim();
  return configured && path.isAbsolute(configured) ? configured : path.join(home, ".local", "bin");
}

function samePath(left: string, right: string) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

export function packageManaged(executable: Executable) {
  return (
    !executable.compiled ||
    executable.path.includes("/node_modules/") ||
    PACKAGE_MANAGED.some((prefix) => executable.path.startsWith(prefix))
  );
}

export type Placement = { command: string[]; placed?: string };

export function placeBinary(
  executable: Executable,
  sourceCommand: string[],
  targetDir: string,
): Placement {
  if (packageManaged(executable)) return { command: sourceCommand };
  const target = path.join(targetDir, "pounce");
  if (samePath(target, executable.path)) return { command: [target] };
  mkdirSync(targetDir, { recursive: true });
  const staged = `${target}.${process.pid}.new`;
  rmSync(staged, { force: true });
  copyFileSync(executable.path, staged);
  chmodSync(staged, 0o755);
  renameSync(staged, target);
  return { command: [target], placed: target };
}

function quoted(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function shellWord(value: string) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : quoted(value);
}

export function shellStartupFile(home: string, env: NodeJS.ProcessEnv, configHome: string) {
  const shell = path.basename(env.SHELL ?? "sh");
  const zdot = env.ZDOTDIR ?? home;
  const candidates =
    shell === "fish"
      ? [path.join(configHome, "fish", "config.fish")]
      : shell === "zsh"
        ? [path.join(zdot, ".zshrc"), path.join(zdot, ".zshenv")]
        : shell === "bash"
          ? [
              path.join(home, ".bashrc"),
              path.join(home, ".bash_profile"),
              path.join(home, ".profile"),
            ]
          : [path.join(home, ".profile")];
  return {
    file:
      candidates.find((candidate) => existsSync(candidate)) ??
      candidates[0] ??
      path.join(home, ".profile"),
    fish: shell === "fish",
  };
}

export function onPathAlready(dir: string, env: NodeJS.ProcessEnv) {
  return (env.PATH ?? "")
    .split(path.delimiter)
    .some((entry) => entry && path.resolve(entry) === path.resolve(dir));
}

export function addToPath(dir: string, home: string, env: NodeJS.ProcessEnv, configHome: string) {
  if (onPathAlready(dir, env)) return undefined;
  const { file, fish } = shellStartupFile(home, env, configHome);
  const line = fish ? `fish_add_path ${quoted(dir)}` : `export PATH=${quoted(dir)}:"$PATH"`;
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.split("\n").includes(line)) return undefined;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}\n# pounce\n${line}\n`);
  return file;
}

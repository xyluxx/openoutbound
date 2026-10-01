/** Where the CLI writes. Data goes to stdout, messages and hints to stderr. */
export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
}

export function processIO(): CliIO {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
  };
}

/** Colors only on a TTY and never when NO_COLOR is set (https://no-color.org). */
export function colorEnabled(isTTY: boolean, env: Readonly<Record<string, string | undefined>>) {
  return isTTY && !env.NO_COLOR;
}

export interface Palette {
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  cyan(text: string): string;
}

const wrap = (open: number, close: number) => (text: string) =>
  `\u001b[${open}m${text}\u001b[${close}m`;

export function palette(enabled: boolean): Palette {
  if (!enabled) {
    const plain = (text: string) => text;
    return { bold: plain, dim: plain, green: plain, yellow: plain, red: plain, cyan: plain };
  }
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    red: wrap(31, 39),
    cyan: wrap(36, 39),
  };
}

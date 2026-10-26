import { parseArgs } from "node:util";

const HELP = `winnow - local photo culler (no cloud)

Usage:
  winnow <folder> [options]

Options:
  --json     Machine-readable output
  --apply    Write sidecars (default is dry-run)
  -h, --help Show this help
`;

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      apply: { type: "boolean" },
    },
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  process.stderr.write("winnow: scanning is not implemented yet\n");
  return 1;
}

process.exitCode = main(process.argv.slice(2));

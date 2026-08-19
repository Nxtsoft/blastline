#!/usr/bin/env node
const USAGE = `blastline — graph-backed test impact and blast radius (built on CGraph)

usage:
  blastline tests <base>..<head>   list tests impacted by the diff
  blastline blast <base>..<head>   list transitive dependents of the diff

status: pre-release scaffold. The selection pipeline lands in phase 2 of
openspec/changes/bootstrap-blastline/proposal.md; nothing is implemented yet.`;

const [, , command] = process.argv;

switch (command) {
  case undefined:
  case "--help":
  case "-h":
    console.log(USAGE);
    process.exit(0);
  case "tests":
  case "blast":
    console.error(`blastline ${command}: not implemented yet (phase 2 — see openspec/changes/bootstrap-blastline/proposal.md)`);
    process.exit(2);
  default:
    console.error(`blastline: unknown command "${command}"\n\n${USAGE}`);
    process.exit(2);
}

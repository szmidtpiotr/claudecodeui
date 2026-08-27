#!/usr/bin/env node
// The server build stages into dist-server.next and this script promotes it
// into place. The live dist-server must never be deleted before the new build
// is complete: an interrupted build would otherwise leave the installation
// without a server entrypoint, crash-looping on MODULE_NOT_FOUND at every
// start until someone rebuilds it by hand.
import fs from 'node:fs';

const NEXT = 'dist-server.next';
const LIVE = 'dist-server';
const OLD = 'dist-server.old';
const ENTRY = 'server/index.js';

const mode = process.argv[2] ?? 'promote';

if (mode === 'recover') {
  // Ran before every server start: if a promotion was interrupted between the
  // two renames, put the previous build back so the server can boot.
  if (!fs.existsSync(`${LIVE}/${ENTRY}`) && fs.existsSync(`${OLD}/${ENTRY}`)) {
    console.error('promote-dist-server: restoring previous dist-server after an interrupted promotion.');
    fs.rmSync(LIVE, { recursive: true, force: true });
    fs.renameSync(OLD, LIVE);
  }
  process.exit(0);
}

// promote mode (default): called by postbuild:server after tsc + tsc-alias finish.
if (!fs.existsSync(`${NEXT}/${ENTRY}`)) {
  console.error(`promote-dist-server: ${NEXT}/${ENTRY} not found — build may have failed.`);
  process.exit(1);
}

// Rotate: live → old, next → live.
fs.rmSync(OLD, { recursive: true, force: true });
if (fs.existsSync(LIVE)) {
  fs.renameSync(LIVE, OLD);
}
fs.renameSync(NEXT, LIVE);
fs.rmSync(OLD, { recursive: true, force: true });

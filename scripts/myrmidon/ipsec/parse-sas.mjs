#!/usr/bin/env node
import { readFileSync } from 'node:fs';

function parse(text) {
  const ikeSas = [];
  let ike = null;
  let child = null;
  let malformed = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let match;
    if ((match = /^([^\s:]+): #(\d+), ([A-Z_]+), IKEv\d+(?:, (?:rekeying|reauthentication) in \d+s)?\s*$/.exec(line))) {
      ike = { name: match[1], id: match[2], state: match[3], children: [] };
      ikeSas.push(ike);
      child = null;
    } else if ((match = /^ {2}([^\s:]+): #(\d+), reqid \d+, ([A-Z_]+), (?:TUNNEL|TRANSPORT|BEET)(?:, (?:ESP|AH):[A-Z0-9_/-]+)?\s*$/.exec(line))) {
      if (!ike) { malformed = true; continue; }
      child = { name: match[1], id: match[2], state: match[3], installed: match[3] === 'INSTALLED', bytesIn: null, bytesOut: null };
      ike.children.push(child);
    } else if (/^\s+(?:in|out)\s/.test(line)) {
      match = /^\s+(in|out)\s+[0-9a-fA-F]+,\s*(\d+) bytes, \d+ packets(?:, \d+s ago)?\s*$/.exec(line);
      if (!child || !match) { malformed = true; continue; }
      const key = match[1] === 'in' ? 'bytesIn' : 'bytesOut';
      if (child[key] !== null) malformed = true;
      child[key] = match[2];
    } else if (!ike || !(
      /^ {2}(?:local|remote)\s+'[^'\r\n]+' @ \S+\[\d+\]\s*$/.test(line) ||
      /^ {4}(?:local|remote)\s+\S+(?:\s+\S+)*\s*$/.test(line) ||
      /^\s+installed \d+s ago(?:, (?:rekeying|expires) in \d+s)*\s*$/.test(line) ||
      /^\s+established \d+s ago(?:, (?:rekeying|reauthentication) in \d+s)*\s*$/.test(line) ||
      /^\s+[A-Z0-9_]+(?:-[0-9]+)?(?:\/[A-Z0-9_]+(?:-[0-9]+)?)+\s*$/.test(line)
    )) {
      malformed = true;
    }
  }
  const healthy = !malformed && ikeSas.length > 0 && ikeSas.every((sa) =>
    sa.state === 'ESTABLISHED' && sa.children.length > 0 && sa.children.every((c) =>
      c.installed && c.bytesIn !== null && c.bytesOut !== null));
  return { status: healthy ? 'healthy' : 'unknown', ikeSas };
}

try {
  if (process.argv.length > 3) throw new Error('usage: node parse-sas.mjs [file]');
  const input = readFileSync(process.argv[2] ?? 0, 'utf8');
  console.log(JSON.stringify(parse(input), null, 2));
} catch (error) {
  console.error(`parse-sas: ${error.message}`);
  process.exitCode = 1;
}

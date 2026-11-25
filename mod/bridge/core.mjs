// Pure logic for the bridge: validating what the Figma plugin sends, and
// deciding whether the latest selection is still live.

export const MAX_NODES = 20;
export const MAX_NAME = 80;
export const MAX_BODY_BYTES = 64 * 1024;
// The plugin re-sends its snapshot every 5 s; past this, the plugin is gone.
export const STALE_AFTER_MS = 15_000;

const FILE_KEY = /^[A-Za-z0-9]{10,64}$/;
// Plain ids look like "6057:5219"; nodes inside instances like "I6057:1;2:3".
const NODE_ID = /^I?\d+:\d+(;\d+:\d+)*$/;
const NODE_TYPE = /^[A-Z_]{2,40}$/;

// Layer and page names are authored by anyone with edit access to the file,
// so they are untrusted: strip control characters, collapse whitespace, cap.
export function cleanName(value) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_NAME ? `${flat.slice(0, MAX_NAME - 1)}…` : flat;
}

// Returns a clean snapshot, or { error } describing the first problem.
export function sanitize(payload) {
  if (!payload || typeof payload !== 'object') return { error: 'body must be a JSON object' };
  const { fileKey, fileName, page, selection, selectionCount } = payload;

  if (fileKey !== null && !(typeof fileKey === 'string' && FILE_KEY.test(fileKey))) {
    return { error: 'fileKey must be null or an alphanumeric key' };
  }
  if (!page || typeof page !== 'object' || typeof page.id !== 'string' || !NODE_ID.test(page.id)) {
    return { error: 'page.id is missing or malformed' };
  }
  if (!Array.isArray(selection)) return { error: 'selection must be an array' };

  const nodes = [];
  for (const node of selection.slice(0, MAX_NODES)) {
    if (!node || typeof node.id !== 'string' || !NODE_ID.test(node.id)) return { error: 'a node id is malformed' };
    if (typeof node.type !== 'string' || !NODE_TYPE.test(node.type)) return { error: 'a node type is malformed' };
    nodes.push({ id: node.id, type: node.type, name: cleanName(node.name) });
  }

  const count = Number.isInteger(selectionCount) && selectionCount >= nodes.length ? selectionCount : nodes.length;
  return {
    snapshot: {
      fileKey: fileKey ?? null,
      fileName: cleanName(fileName),
      page: { id: page.id, name: cleanName(page.name) },
      nodes,
      count,
    },
  };
}

// What a reader is told: the snapshot only while the plugin is still sending.
export function view(latest, now) {
  if (!latest) return { selection: null, ageMs: null };
  const ageMs = now - latest.receivedAt;
  return { selection: ageMs <= STALE_AFTER_MS ? latest.snapshot : null, ageMs };
}

// The Figma logo from Nerd Fonts (nf-fa-figma), as the mod's chip uses.
export const FIGMA_ICON = String.fromCodePoint(0xef47);
// The status line gives Figma a row of its own, so allow the full cleaned name.
const STATUS_NAME_MAX = MAX_NAME;
const PATH_PART_MAX = 32;

function clipName(name, max) {
  return name.length > max ? `${name.slice(0, max - 1).replace(/[\s·•|/+\-–—:,]+$/u, '')}…` : name;
}

// One line for a status bar: the logo, then file › page › layer (or a count).
// Empty when nothing live is selected, so a status bar widget can hide itself.
//    Acme App › Screens › Checkout · Payment sheet
//    Acme App › Screens › 3 layers
export function statusLine(selection) {
  if (!selection || selection.count === 0) return '';
  const first = selection.nodes[0];
  const what = selection.count > 1 || !first
    ? `${selection.count} layers`
    : clipName(first.name || first.type, STATUS_NAME_MAX);
  const path = [selection.fileName, selection.page?.name].filter(Boolean).map(part => clipName(part, PATH_PART_MAX));
  return `${FIGMA_ICON} ${[...path, what].join(' › ')}`;
}

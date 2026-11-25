// Tether: sends the current selection to the Tether bridge on this machine.
// Read-only: this plugin never changes the document.
const MAX_NODES = 20;
const HEARTBEAT_MS = 5000;
const WIDTH = 300;

figma.showUI(__html__, { width: WIDTH, height: 196, title: 'Tether', themeColors: true });

function snapshot() {
  let fileKey = null;
  try { fileKey = figma.fileKey || null; } catch (_) { fileKey = null; }
  const selection = figma.currentPage.selection;
  return {
    fileKey,
    fileName: figma.root.name,
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    selection: selection.slice(0, MAX_NODES).map(n => ({ id: n.id, name: n.name, type: n.type })),
    selectionCount: selection.length,
  };
}

const push = () => figma.ui.postMessage({ type: 'snapshot', snapshot: snapshot() });

figma.ui.onmessage = async msg => {
  if (!msg) return;
  if (msg.type === 'ready') {
    const token = await figma.clientStorage.getAsync('bridgeToken');
    figma.ui.postMessage({ type: 'token', token: token || null });
    push();
  } else if (msg.type === 'save-token') {
    await figma.clientStorage.setAsync('bridgeToken', msg.token);
    push();
  } else if (msg.type === 'forget-token') {
    await figma.clientStorage.deleteAsync('bridgeToken');
    push();
  } else if (msg.type === 'resize') {
    // The UI measures itself so each state gets a snug window.
    figma.ui.resize(WIDTH, Math.max(120, Math.min(400, Math.ceil(msg.height))));
  }
};

figma.on('selectionchange', push);
figma.on('currentpagechange', push);
// Keeps the bridge from treating an idle-but-open plugin as gone.
setInterval(push, HEARTBEAT_MS);

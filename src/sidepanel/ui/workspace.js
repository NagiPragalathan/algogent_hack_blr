import { els } from '../core/dom.js';
import { state } from '../core/state.js';
import { setHint } from './hint.js';
import { TEXT_LIMIT } from './attachments.js';

/**
 * A folder of text files that rides along with every question.
 *
 * Uses the File System Access API, which needs a user gesture and is not
 * available everywhere — so the failure is reported plainly rather than leaving
 * a control that quietly does nothing.
 */

const WORKSPACE_TEXT =
  /\.(txt|md|markdown|json|csv|tsv|log|js|ts|jsx|tsx|py|java|c|cpp|cs|go|rs|rb|php|html|css|xml|ya?ml|sql|sh)$/i;
const MAX_FILES = 20;

export async function chooseWorkspace() {
  if (!window.showDirectoryPicker) {
    setHint('This browser will not let the panel open a folder.', 'error');
    return;
  }

  let dir;
  try {
    dir = await window.showDirectoryPicker({ mode: 'read' });
  } catch {
    return; // the user cancelled
  }

  const files = [];
  try {
    for await (const [name, handle] of dir.entries()) {
      if (files.length >= MAX_FILES) break;
      if (handle.kind !== 'file' || !WORKSPACE_TEXT.test(name)) continue;
      const file = await handle.getFile();
      files.push({ name, text: (await file.text()).slice(0, TEXT_LIMIT) });
    }
  } catch (err) {
    setHint('Could not read that folder: ' + String(err?.message || err), 'error');
    return;
  }

  state.workspace = { name: dir.name, files };
  renderWorkspace();
  setHint(`Workspace “${dir.name}” — ${files.length} file${files.length === 1 ? '' : 's'}.`);
}

export function clearWorkspace() {
  state.workspace = null;
  renderWorkspace();
  setHint('');
}

export function renderWorkspace() {
  const on = Boolean(state.workspace);
  const count = state.workspace?.files.length ?? 0;

  els.workspaceLabel.firstChild.textContent = on ? state.workspace.name : 'Choose a folder';
  els.workspaceNoneCheck.style.visibility = on ? 'hidden' : 'visible';
  els.workspaceSub.textContent = on
    ? `${state.workspace.name} · ${count} file${count === 1 ? '' : 's'}`
    : 'No folder chosen';
}

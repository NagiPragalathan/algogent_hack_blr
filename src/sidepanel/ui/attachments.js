import { els, make } from '../core/dom.js';
import { state } from '../core/state.js';
import { icon } from '../lib/icons.js';
import { setHint } from './hint.js';

/**
 * Files and page regions queued for the next question.
 *
 * Both are read here in the panel and travel with the question as plain text —
 * nothing is uploaded, and nothing outlives the question it was attached to.
 */

/** Per-file ceiling. A single huge file would crowd out the page itself. */
export const TEXT_LIMIT = 40000;
export const MAX_FILES = 5;

/**
 * Files whose contents we cannot read, and do not need to.
 *
 * A PDF résumé, a Word document, a spreadsheet, a picture — extracting text
 * from these in the panel would mean shipping a parser per format, and the
 * result would be worse than what the provider does with the file itself. So
 * they take the other road: the adapter pastes the actual file into the
 * provider's own composer, the same way the screenshot path already does, and
 * the provider reads it with whatever it uses for uploads.
 */
const UPLOAD_TYPES =
  /\.(?:pdf|docx?|pptx?|xlsx?|rtf|odt|png|jpe?g|gif|webp|avif|heic|svg)$/i;

/** Chrome ports carry this comfortably; a 30MB slide deck is not the job. */
const UPLOAD_LIMIT = 20 * 1024 * 1024;

export const readAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/**
 * The same sort, by MIME type, for a file that arrived without a usable name.
 *
 * A picture off the clipboard is a `File` called "image.png" on a good day and
 * nothing at all on a bad one, and a name-only test then sends a PNG down the
 * text road — `file.text()` on binary produces a page of replacement characters
 * and attaches it as if it were a document.
 */
const UPLOAD_MIME = /^(?:image\/|application\/(?:pdf|msword|vnd\.|rtf))/i;

/**
 * Which road a file takes: read here as text, or handed to the provider whole.
 *
 * Exported because a skill's reference files are sorted by exactly the same
 * rule, months after they were picked — see `ui/skill-files.js`. Two copies of
 * this test would drift, and the drift is invisible: a `.pdf` sorted the wrong
 * way is attached as a page of replacement characters and looks like a file
 * that arrived.
 */
export const fileKind = (file) =>
  UPLOAD_TYPES.test(file.name || '') || UPLOAD_MIME.test(file.type || '') ? 'upload' : 'text';

export async function attachFiles(fileList) {
  for (const file of fileList) {
    if (fileKind(file) === 'upload') {
      await attachUpload(file);
      continue;
    }

    if (state.files.length >= MAX_FILES) {
      setHint(`${MAX_FILES} files is the limit for one question.`, 'warn');
      break;
    }
    try {
      const text = await file.text();
      state.files.push({ name: file.name, text: text.slice(0, TEXT_LIMIT) });
    } catch {
      setHint(`Could not read ${file.name}.`, 'error');
    }
  }
  renderAttachmentChips();
}

/**
 * Queue a real file for the provider's uploader.
 *
 * One at a time, and it shares the slot with a dragged screenshot: the composer
 * pastes into the provider's own input, and every provider we drive accepts
 * exactly one attachment there. Saying so beats silently sending the first one
 * and dropping the second.
 */
async function attachUpload(file) {
  // A clipboard picture often has no name, and the provider's uploader shows
  // the user whatever we give it — "attachment" beside a screenshot is worse
  // than useless, so it gets one that says where it came from.
  const name = file.name || `pasted-image.${(file.type.split('/')[1] || 'png').slice(0, 4)}`;

  if (file.size > UPLOAD_LIMIT) {
    setHint(`${name} is too large to send (limit ${UPLOAD_LIMIT / 1024 / 1024}MB).`, 'error');
    return;
  }

  try {
    state.upload = {
      name,
      type: file.type || '',
      size: file.size,
      dataUrl: await readAsDataUrl(file)
    };
    if (state.pickedImage) {
      state.pickedImage = null;
      setHint(`${name} replaced the picture — one attachment per question.`, 'warn');
    } else {
      setHint(`${name} will be uploaded to the provider with your question.`);
    }
  } catch {
    setHint(`Could not read ${name}.`, 'error');
  }
}

/**
 * Everything queued for the next question, as one row of cards.
 *
 * One shape for all three kinds, and it is the taller one. A 57px picture
 * standing next to a 24px pill is not a row, it is two rows that happen to
 * overlap — the eye reads a mistake before it reads the contents. So the file
 * and the picked element grew into cards of the picture's height, and every
 * card carries the same three things: what it is, what it came from, and one
 * way to remove it.
 */
export function renderAttachmentChips() {
  document.getElementById('file-chips')?.remove();
  if (
    !state.files.length &&
    !state.picked &&
    !state.pickedImage &&
    !state.upload &&
    !state.skill
  ) {
    return;
  }

  const wrap = make('div', 'attach-chips');
  wrap.id = 'file-chips';

  if (state.skill) {
    /**
     * The command, not its contents.
     *
     * A skill is the only attachment that is a way of asking rather than a
     * thing to ask about, so it leads the row and looks different: accent, the
     * slash command in monospace, and the title as the sub-line. Its full text
     * is in the tooltip for anyone who wants to check what they armed.
     */
    const chip = make('div', 'skill-chip');
    chip.title = state.skill.body;

    chip.append(
      make('span', 'skill-chip-cmd', `/${state.skill.slug}`),
      make('span', 'skill-chip-title', state.skill.title)
    );

    chip.append(
      removeButton('Remove this skill', 'skill-chip-drop', () => {
        state.skill = null;
        renderAttachmentChips();
        els.input.focus();
      })
    );

    wrap.append(chip);
  }

  if (state.pickedImage) {
    // The crop is the only attachment whose contents cannot be named — that is
    // the whole reason to send a picture — so it shows itself rather than a
    // label, and the dimensions are stamped on it rather than sat beside it.
    const tile = make('div', 'shot-tile');
    tile.title = `${state.pickedImage.title || 'Selection'} — sent with your next question`;

    const thumb = make('img');
    thumb.src = state.pickedImage.dataUrl;
    thumb.alt = 'Selected region of the page';
    // A 76px tile proves something was captured; only full size proves it was
    // the right thing — and the answer is unusable if it was not.
    thumb.addEventListener('click', () => openShot());

    const dims = make(
      'span',
      'shot-size',
      `${state.pickedImage.width}×${state.pickedImage.height}`
    );

    tile.append(thumb, dims, removeButton('Remove this picture', 'shot-drop', () => {
      state.pickedImage = null;
      renderAttachmentChips();
    }));
    wrap.append(tile);
  }

  if (state.picked) {
    wrap.append(
      card({
        // Highlighted text and a pointed-at element are different gestures and
        // the card says which: one you did on the page just now and can undo by
        // clicking anywhere, the other you chose deliberately through the menu.
        glyph: state.picked.fromSelection ? 'book' : 'crosshair',
        title: state.picked.label || 'Selection',
        meta: state.picked.fromSelection
          ? `Selected text · ${state.picked.text.length} chars`
          : state.picked.title || 'from this page',
        onRemove: () => {
          state.picked = null;
          renderAttachmentChips();
        }
      })
    );
  }

  if (state.upload) {
    // Named for what actually happens to it: this one is handed to the
    // provider's own uploader rather than pasted into the prompt as text.
    // A picture shows itself in place of the icon — the point of pasting a
    // screenshot is that its contents have no name.
    wrap.append(
      card({
        glyph: 'folder',
        thumb: state.upload.type.startsWith('image/') ? state.upload.dataUrl : null,
        title: state.upload.name,
        // Where it came from leads, when it came from somewhere: a card you did
        // not drag in yourself is otherwise a file appearing on its own.
        meta: from(state.upload, `Uploaded to the provider · ${humanSize(state.upload.size)}`),
        onRemove: () => {
          state.upload = null;
          renderAttachmentChips();
        }
      })
    );
  }

  for (const file of state.files) {
    wrap.append(
      card({
        glyph: 'file',
        title: file.name,
        meta: fileMeta(file),
        onRemove: () => {
          state.files = state.files.filter((f) => f !== file);
          renderAttachmentChips();
        }
      })
    );
  }

  els.context.after(wrap);
}

const humanSize = (bytes) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** "MD · 4.2 KB" — the two things worth knowing about a file you cannot see. */
function fileMeta(file) {
  const ext = (file.name.split('.').pop() || '').toUpperCase().slice(0, 4);
  const kb = file.text.length / 1024;
  const size = kb < 1 ? `${file.text.length} chars` : `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return from(file, ext ? `${ext} · ${size}` : size);
}

/**
 * "/resume · PDF · 210 KB".
 *
 * A skill's reference file lands in the same row as one you dragged in, and
 * without the command in front of it there is nothing on screen saying why a
 * CV you did not just choose is about to be sent.
 */
const from = (file, meta) => (file.fromSkill ? `/${file.fromSkill} · ${meta}` : meta);

function card({ glyph, title, meta, onRemove, thumb = null }) {
  const el = make('div', 'attach-card');
  el.title = `${title} — sent with your next question`;

  const badge = make('span', 'attach-card-icon');
  if (thumb) {
    const img = make('img');
    img.src = thumb;
    img.alt = title;
    badge.classList.add('has-thumb');
    badge.append(img);
  } else {
    badge.innerHTML = icon(glyph, 15);
  }

  const main = make('span', 'attach-card-main');
  main.append(make('span', 'attach-card-title', title), make('span', 'attach-card-meta', meta));

  el.append(badge, main, removeButton('Remove', 'attach-card-drop', onRemove));
  return el;
}

function removeButton(label, className, onRemove) {
  const button = make('button', className);
  button.innerHTML = icon('close', 10);
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onRemove);
  return button;
}

/**
 * The picked picture at full size, over the panel.
 *
 * In the panel rather than a new tab: Chrome refuses to navigate to a `data:`
 * URL from an extension page, and writing the crop somewhere first to get a URL
 * for it would mean the picture outliving the question it was attached to.
 */
export function openShot() {
  if (!state.pickedImage) return;
  els.lightboxImg.src = state.pickedImage.dataUrl;
  els.lightboxMeta.textContent =
    `${state.pickedImage.width}×${state.pickedImage.height} · ` +
    (state.pickedImage.title || 'this page');
  els.lightbox.hidden = false;
}

export function closeShot() {
  els.lightbox.hidden = true;
  // Drop the data URL: a full-page PNG is megabytes, and holding it in an <img>
  // that nobody is looking at keeps it decoded in memory for the session.
  els.lightboxImg.removeAttribute('src');
}

/** Attachments belong to the question that was just sent, not the next one. */
export function clearAttachments() {
  state.files = [];
  state.picked = null;
  state.pickedImage = null;
  state.upload = null;
  state.skill = null;
  closeShot();
  renderAttachmentChips();
}

/**
 * Turning what the rest of the extension carries an image as into what an
 * upload endpoint wants.
 *
 * Everywhere else — the agent's screenshots, a dragged region, a pasted
 * picture — an image travels as a `data:` URL, because that is what
 * `captureVisibleTab` returns and what survives a `chrome.runtime` message.
 * Every upload endpoint wants bytes and a MIME type. This is the one place
 * that converts, so a provider engine never has to think about it.
 *
 * `atob` rather than `fetch(dataUrl)`: a fetch of a data URL is one more thing
 * that can fail, and its only symptom would be an attachment that never
 * appears — which is precisely the failure this whole path exists to avoid.
 */

/** @returns {{ mime: string, bytes: Uint8Array, name: string }|null} */
export function decodeDataUrl(dataUrl, fallbackName = 'image.jpg') {
  if (typeof dataUrl !== 'string') return null;

  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;

  const [, mime, isBase64, payload] = match;

  let bytes;
  try {
    const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return null;
  }

  /**
   * A name per image, never a constant.
   *
   * The relay path learned this the hard way: a run sends many screenshots, and
   * ChatGPT answers a second `screenshot.jpg` with "You've already uploaded
   * this file" instead of an upload. Nothing here would see that dialog, but
   * the underlying rule is the provider's, not the page's — so the name is
   * stamped for the same reason it is stamped over there.
   */
  const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'jpg';
  const name = fallbackName.includes('.')
    ? fallbackName
    : `${fallbackName}-${Date.now().toString(36)}.${ext}`;

  return { mime, bytes, name };
}

/**
 * The two shapes an attachment arrives in, turned into the one an engine wants.
 *
 * A screenshot is a bare `data:` URL — that is what `captureVisibleTab` hands
 * back — while a file the user picked is `{dataUrl, name, type}`, because a
 * provider's uploader decides what to do with a document from its MIME type and
 * shows the person its filename. `adapter.js` has normalised both since the day
 * documents were added (`asAttachment`); the engines here never did, and the
 * cost was the worst kind of failure this codebase has.
 *
 * `decodeDataUrl` was handed the OBJECT, found it was not a string, and
 * returned null — which reads identically to "there was no attachment". So the
 * turn went out with the CV silently dropped, while `askDirect` reported
 * `attached: true` because something had been passed in, and the prompt above it
 * said "the user has attached their own file". An answer written without the CV
 * then looked exactly like one written from it, in a run whose entire point was
 * the CV. Nothing anywhere could have told you.
 *
 * @returns {{ mime: string, bytes: Uint8Array, name: string }|null}
 */
export function asFile(value, fallbackName = 'image.jpg') {
  if (!value) return null;
  if (typeof value === 'string') return decodeDataUrl(value, fallbackName);
  if (typeof value.dataUrl !== 'string') return null;

  const decoded = decodeDataUrl(value.dataUrl, value.name || fallbackName);
  if (!decoded) return null;

  /**
   * The picker's own type wins over the data URL's.
   *
   * A `.docx` read through `FileReader` routinely carries
   * `application/octet-stream`, and an upload endpoint told that will either
   * refuse it or accept it as an opaque blob nothing will read. The name wins
   * for the same reason it does in the adapter: it is what the user sees, and
   * it is the only evidence a document arrived.
   */
  return {
    ...decoded,
    mime: value.type || decoded.mime,
    name: value.name || decoded.name
  };
}

/**
 * Something the model can look at, as opposed to a document it has to read.
 *
 * The distinction is not cosmetic at either provider: an image and a file take
 * different upload calls and appear in different parts of the message, and
 * sending one as the other is accepted and then read by nothing.
 */
export const isImage = (file) => /^image\//i.test(file?.mime || '');

import { useEffect } from "react";

/** The suffix every page carries, so the brand is never typed twice. */
const SUFFIX = "Algogent";

/**
 * The document title for a route.
 *
 * A single-page app never reloads, so the <title> in index.html is the one the
 * visitor keeps — every route would sit in the tab under the home page's name,
 * and a bookmark of /agents would be saved under it too.
 */
export function usePageTitle(title?: string) {
  useEffect(() => {
    document.title = title ? `${title} — ${SUFFIX}` : `${SUFFIX} — Agent Marketplace`;
  }, [title]);
}

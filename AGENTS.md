# Working in this repo

A Chrome extension (MV3) that puts ChatGPT, Gemini, Claude and Meta AI in a side
panel, driving the user's own logged-in sessions rather than an API key. It can
also act: agent mode clicks, types and navigates on the current page.

No build step, no bundler, no dependencies. What is on disk is what Chrome runs.
Load it with **Load unpacked** at `chrome://extensions`, and **reload the
extension** after touching anything under `src/background/` — the service worker
does not hot-reload.

---

## Where things live

```
manifest.json            every entry point and content script is declared here
rules/                   declarativeNetRequest rules (frame CSP relaxation)

src/providers/
  config.js              provider definitions, selectors, defaults

src/background/          the service worker and everything behind it
  service-worker.js      ENTRY. Wiring only — one line per listener
  relay.js               the hidden window that hosts provider tabs
  embedded.js            provider frames in an offscreen document
  api.js                 official-API transport (present but NOT wired up)
  state/
    settings.js          loadState(), isEmbedded()
    conversations.js     which provider thread each provider is in
    user-tabs.js         which tab the user is actually looking at
  context/
    capture.js           reading pages through the content script
    prompt.js            wrapping a question with page text
    handoff.js           right-click and highlighted text, on their way in
  transport/
    inflight.js          in-flight requests + the MV3 keep-alive
    ask-provider.js      one prompt to one provider, retried through a stall
    recover.js           closing and reopening what a provider talks through
    deep-ask.js          one question, several turns: read in parts, then answer
    direct/              the fast path: the provider's own API, no page at all
      index.js           the front door — which turns take it, and the fallback
      stream.js          reading a response line by line as the bytes arrive
      gemini.js          batchexecute, and the token in the app shell
      chatgpt.js         backend-api, behind the sentinel handshake
      sentinel.js        the proof of work that handshake asks for (SHA3-512)
      claude.js          claude.ai/api — org, conversation, completion
      meta.js            GraphQL persisted queries, account or throwaway
      notrack.js         no credential at all — plain JSON in, event stream out
      upload.js          a data: URL, turned into the bytes an uploader wants
      headers.js         session rules: look like the page, not like a worker
      pace.js            how often we may ask, and when to stop asking
  agent/
    index.js             the front door — import from here
    limits.js            MAX_STEPS, OBSERVE_CHARS, MAX_AUTO_LOOKS, scan sizes
    protocol.js          the action vocabulary and reply parsing
    page.js              reaching into a tab: observe, settle, screenshot
    session-tabs.js      which tabs are the run's, and the group that says so
    actions.js           carrying out one action, and the approval gate
    plan.js              the survey turn: whole page in, a route out
    read.js              transcribing one over-long observation, part by part
    read-url.js          fetching a page's text without opening it (anonymous)
    loop.js              the observe -> decide -> act driver
    run.js               the worker side: one run at a time, provider plumbing
  channel/
    panel.js             the side panel's port, and every message it can send

tests/
  direct/notrack.test.mjs  the engine driven on a faked stream: node tests/direct/notrack.test.mjs
  direct/scrub.test.mjs    citation scaffolding, and that both copies of it agree
  agent/run-slot.test.mjs  the one-run-at-a-time slot, and Stop unwinding
  agent/survey-turn.test.mjs  the plan and the first action in one round trip
  agent/not-a-task.test.mjs   "hyy" must not take over the browser
  agent/blind-transport.test.mjs  when a run may take the fast path with no camera
  agent/new-tab-window.test.mjs   open_tab must not open into the relay window
  agent/action-json.test.mjs      a markdown answer, from the reply to the HTML
  agent/dead-ends.test.mjs        a 404 is a dead link, not an unreadable page
  content/frame-guard.test.mjs  only the top frame answers a broadcast
  panel/receipts.html      the fee block, and a hostile tool label as TEXT
  panel/*.html           self-checking browser fixtures — see the end of this file

src/content/             classic content scripts (NOT ES modules — see below)
  page-context.js        text extraction and the element picker
  agent-page.js          the agent's eyes and hands in a page

src/adapters/
  adapter.js             drives a provider's web UI (classic script)

src/offscreen/           the offscreen document hosting provider frames
src/options/             the settings page

src/sidepanel/           the panel UI
  sidepanel.html         all markup. Nothing builds HTML strings in JS
  sidepanel.js           ENTRY. boot() and nothing else
  sidepanel.css          @import list only — the cascade order lives here
  styles/                one stylesheet per concern
  core/                  dom, state, bus, port, sessions
    runs.js              which conversation each thing in flight belongs to
  ui/                    one module per surface: thread, composer, sheets …
    scroll.js            where the thread is scrolled and what that drives
    running.js           the one line for a run in a chat you are not watching
    composer-ink.js      the badge layer behind the composer, and the tokens
    skills.js            the library: load, list, arm one for the next question
    skill-editor.js      writing one — prompt, command, and the files it keeps
    skill-files.js       those files: reading them in, choosing one, arming them
  app/                   messages.js (what the worker says), events.js (clicks)
    slash.js             the '/' skill typeahead, sibling of mentions.js
  lib/                   icons, markdown, highlight, preset-skills — no knowledge
                         of this panel
  payments/              paying a skill's author, per use
    x402.js              quote, sign, settle — and every reason not to charge
    ledger.js            the local mirror of settled receipts, per conversation
```

The marketplace half lives in `site/` (a separate Vite app, deployed to
algogent.vercel.app) and is where anything that decides money lives:

```
site/
  db/schema.sql          developers, agents, receipts. Money is BIGINT microALGO
  db/apply.mjs           the only way the schema is applied
  api/_lib/split.js      the 80/20 arithmetic. Integer only, remainder to the dev
  api/_lib/algorand.js   builds the atomic group, re-checks it, submits it
  api/agents/register    a developer publishes an agent and a payout address
  api/x402/quote         the 402 challenge + the unsigned group
  api/x402/settle        verify → submit → confirm → THEN write the receipt
  api/receipts/          the fee history the panel prints
  src/lib/registry.ts    the typed client. UI-free
```

## Keep it this way

**One concern per file, and name the file after the concern.** `ui/thread.js`
renders the thread. `state/user-tabs.js` answers "which tab is the user on".
When you cannot name a file in a short phrase, it is doing two things.

**Split by concern, never by line count.** `relay.js` is 570 lines and stays one
file: it is one subsystem with tightly shared mutable state, and splitting it
would mean inventing getter/setter plumbing purely to hit a size target. That is
worse organisation, not better. Conversely, a 200-line file doing three
unrelated jobs should be three files.

**A file over ~400 lines deserves a second look**, not an automatic split. Ask
what concern it has absorbed.

**Entry points stay thin.** `service-worker.js` and `sidepanel.js` are wiring:
registering listeners, calling `boot()`. Behaviour goes in a module. If you find
yourself adding logic to an entry point, the module it belongs to is missing.

**Add to an existing file before making a new one.** A folder of fifteen
40-line files is as hard to navigate as one 600-line file.

## Rules that will bite you

**A chat question no longer opens a window, and an agent run still does.**
`transport/direct/` posts to the same endpoint the provider's own page posts
to, using the same cookies, and reads the reply as a stream. Everything the
relay path exists to do — create a window, load a single-page app, arm four
anti-throttle layers including a debugger attachment, inject an adapter, type
into a contenteditable, click send, then poll the DOM until the text has not
changed for `stabilityMs` — is overhead around an answer, and the last of those
is overhead *per reply*: the settle rule cannot know a reply has finished, so it
waits to find out. A stream simply ends. `askProvider` therefore tries
`askDirect` first and falls through to the loop below it, and every engine there
speaks an undocumented, unversioned endpoint its owner changes without notice —
so a break must degrade to "slower", never to "broken". Nothing in that folder
reports a failure to the user: it returns null and the window answers.

**A run may give up its camera to take the fast path — but only after the page
and the task have both said it will not need one.** The rule below is right
that a run cannot change transport halfway. It quietly assumed something else:
that every run needs vision. Most do not. Screenshots are rationed to
`MAX_AUTO_LOOKS` precisely because they are the most expensive thing in a turn,
and the ordinary run — a form, a search, a list of results — never takes one. So
Claude, Meta AI and NoTrack were paying the window's ten-to-forty seconds on
every one of thirty turns to keep a capability they never used.

The question is now asked in two halves. `directRunnable` is "can this engine
deliver a picture" — yes means direct with vision intact, unchanged.
`directTextRunnable` is "is there an engine here at all" — yes means the run MAY
go direct, and `decideTransport` in `run.js` settles it from what `loop.js`
finds. Still ONCE, before the first ask; that invariant is untouched, and it is
the whole of the correctness.

`needsVision` is two tests and they catch different things. `opaqueStart` is the
PAGE saying it cannot be read — canvas, video, embedded PDF, a frame with no
text — which is exactly where working from the DOM produces a confident answer
about something nobody looked at. `VISUAL_TASK` is the USER saying it: "edit
this canvas", "read the PDF", "what does this chart show". Either one keeps the
camera, which means the window. It errs towards vision on purpose — being wrong
that way costs seconds a turn, being wrong the other way costs the run its eyes
on the one page that needed them — and `VISUAL_TASK` is matched against
`instructionOf(task)` for the same reason `WHOLE_PAGE_TASK` is: a CV mentioning
"design" must not put every run that carries one onto the window.

`opaqueStart` is already null on the placeholder start page, and that carries
over exactly right: google.com reads as an unreadable frame (see below), so
judging a blank start by it would drag every one of those runs onto the window
over a page the task is not about. The residual cost is a run that navigates to
a PDF and finds it has no camera — and it SAYS so and finishes, which is the
behaviour this whole area is built around.

Two things make the trade honest rather than a silent downgrade. The model is
TOLD, in the closing block of every turn (`blind` in `closing()`), that there is
no camera, that `screenshot` will be declined, and specifically that it must not
guess x/y — because the failure next door is a model reasoning about a picture
it never saw. And the timeline says it once, naming the trade, so "why is this
run fast" and "why did it not look at the chart" have the same answer on screen.
`survey()` also skips its stitched capture when blind: seconds spent
photographing a page for a message that cannot carry it.

**Speed: the artificial spacing came down, the stand-down did not.** On the
user's explicit instruction, `CHAT_GAP_MS` 1100 → 400, `RUN_GAP_MS` 2600 → 800,
the jitter tail 3× → 1.8×, and `AGENT_BEAT_MS` 420 → 140. The run gap's old
justification — "a minute across a forty-step run is single-digit percent
against turns of ten to forty seconds" — was true only while every run went
through a window; on the fast path a turn is two or three seconds and 2.6s in
front of it is most of the wait. The read term is now ZERO for `intent: 'run'`:
it models a person taking in the last answer before typing the next thing, which
is a fair model of a chat and a plainly false one of a loop, where the reply went
to a parser and the next prompt was already being built.

What is deliberately NOT reachable from any of this: `coolOff`. A 429 or a 403 is
the provider having said no in the only way it has, and no setting and no
instruction touches that branch. The hourly ceiling stays too — it is what makes
a runaway loop visible.

**The user's question goes first as well as last.** A page extract runs to
thousands of characters, and a prompt that opens with the page and asks the
question underneath it has the model read everything before it knows what it is
looking for — which is how a question about one line of a job board comes back
as a summary of the board. `buildPrompt` now states it up front and keeps the
closing `<question>` block, and the agent's first message opens with `THE USER'S
TASK` above the action vocabulary. Not redundancy: primacy turns the read into a
search, recency is where these models take their instruction from, and the two
positions are doing different jobs.

**The answer is rendered as markdown and nothing told the model so.** Measured on
the Gmail run: five messages, each with a subject, a sender and a summary,
delivered as one 90-word sentence with "1)… 2)… 3)…" inside it. Every fact was
there and none of it was findable. The `finish` rule now names the shape — "## "
headings, "- " bullets, bold for the thing being named, a table when the items
share fields, one bullet per item and never one paragraph — because "use
markdown" is not specific enough to change what a model writes. It also says
newlines must be `\n`, since the answer travels inside a JSON string.

**Asking for markdown was half the job; the other half is that a single newline
had to survive the renderer, the JSON and the stylesheet.** All three ate it, and
each failure looked like the model writing badly.

*The renderer.* CommonMark says a single newline inside a paragraph is a SPACE,
which is right for a document and wrong for a chat panel. Measured on a run
comparing AI coding tools, where the model wrote a line per field:

```
Company: Anysphere
Main purpose: AI-first code editor
Key features: agent coding, tab autocomplete, MCP servers
Pricing/free plan: Hobby is free; plans from $20/month
```

`flushParagraph` joined those with `' '` and produced one run-on paragraph — every
fact present, every boundary between them gone, five items over. It is the same
failure the table branch beside it was written for, one level down. It joins with
`<br>` now, which is what GitHub, Slack and the providers' own UIs do, for the
same reason: pressing return means pressing return. The join happens BEFORE
`inline`, not after, so emphasis and a link spanning two lines still resolve —
every pattern in `inline` excludes `\n` and none of them excludes the `<br>` that
replaced it. Inserting our own tag after `escapeHtml` is safe for exactly the
reason the table cells are: the text is already escaped, so this tag cannot be
one of theirs.

*The stylesheet.* `lib/markdown.js` offsets headings by two — `#` is h3, `##` is
h4, `###` is h5 — and one rule in `thread.css` set h3 through h6 to 14.5px
against 13px body text. So every level in an answer rendered identically: the
model was asked for sections and items, produced them, and the panel drew them
flat. They are three sizes now, and `##` carries a hairline rule above it,
because in a 400px column a size difference of one pixel is not a difference.

*The JSON.* See `repairStrings` below — that one loses the whole answer rather
than flattening it.

*The instruction.* The same run numbered every item "1.", because each one opened
its own single-item ordered list with paragraphs between them. Told only to "give
each item its own bullet", a model writes the item as a bullet and the fields as
prose underneath, which is precisely what happened. The rule now names the shape:
a `###` heading per item, one `- **Field** — value` bullet per fact, a blank line
between every block, and lead with the finding rather than with a description of
the run the user just watched. Sources are asked for as `[label](url)` for the
same reason and in the same place: the renderer only linkifies that form, and
autolinking a bare URL in `inline()` means a regex hunting for one in
already-rendered HTML, which has to dodge the inside of a `<code>` span and the
inside of an `href` it wrote a line earlier. Getting that wrong turns a
provider's answer into markup, and the prompt costs nothing.

**An agent run picks its transport ONCE, and the test is "can this engine carry
a picture?"** A run is thirty round trips rather than one, so it is where the
speed-up is worth most — and it is also the case that breaks first if the
transport is chosen per turn, because some of its turns carry a screenshot and
most do not. Answering the text turns directly and the picture turns through the
window splits one run's history across two provider threads that cannot see each
other, and the model reasons across a gap nothing told it about. Dropping the
picture instead is worse: the prompt SAYS one is attached, so it invents
coordinates for an image it never saw. So `directRunnable` asks only whether the
engine has an upload flow, `run.js` calls it once before the first step, and the
answer is passed down every turn. ChatGPT (three hops: reserve, PUT to Azure,
confirm — and skipping the third leaves a file id that is not attachable, so the
message is accepted and answered as if no image had been sent) and Gemini (one
POST to the push host, and the identifier goes in the PROMPT slot, not a field
of its own) both qualify. Claude and Meta have no upload flow here yet, so their
runs stay on the window, whole.

`attached` is emitted on `done` and never on `submitted`, because the upload
happens inside `ask` — claiming delivery before it has happened is exactly the
false claim the flag exists to prevent. An upload that fails throws with nothing
streamed, which hands the turn to the window and lets the provider's own
uploader try. It is also the ENGINE's answer rather than an inference from the
argument: `image ? true` says only "something was passed in", which stayed true
after the engine had failed to read what it was handed — see below.

**An attachment arrives in two shapes, and the engines only understood one.** A
screenshot is a bare `data:` URL, because that is what `captureVisibleTab`
returns; a file the user picked is `{dataUrl, name, type}`, because a provider's
uploader decides what to do with a document from its MIME type and shows the
person its filename. `adapter.js` has normalised both since documents were added
(`asAttachment`); the engines called `decodeDataUrl` straight, which found an
object where it wanted a string and returned null — indistinguishable from "no
attachment". So the CV was dropped, the prompt above it still said "the user has
attached their own file", and `askDirect` reported `attached: true` because
`image` was truthy. The panel's chip read **attached** over an answer written
without it, and nothing anywhere could have told you. `asFile()` in `upload.js`
is the one normaliser; the picker's `type` and `name` win over the data URL's,
because a `.docx` routinely arrives as `application/octet-stream` and an
uploader told that will not read it.

An attachment that cannot be read is a THROW, never a turn without one — the
message describes a file it does not carry, and nothing downstream can tell that
from one that arrived. Throwing hands the turn to the relay, whose uploader has
four routes and a delivery check behind it.

**"Can it carry a picture?" and "can it carry a document?" are two questions.**
`images` and `files` are separate exports for that reason, and `askDirect` asks
whichever the turn actually needs. At ChatGPT they are genuinely different
calls: `use_case: 'multimodal'` files are addressed by an `image_asset_pointer`
the model LOOKS at, `my_files` are handed to the file-reading tool. A PDF
uploaded as `multimodal` is accepted, given a pointer, and then read by nothing
— the turn succeeds and the answer is written as if no CV had been sent. So a
document is named in `metadata.attachments` alone and its content parts stay
plain `text`; only a picture becomes a `multimodal_text` part. Gemini's push
host asks nothing about what the bytes are, so both are one call there — but the
capability is still declared separately, because it comes apart at the other
engines.

**`ready` is a phase, not a keystroke, and the label claimed the keystroke.**
It is posted the instant the adapter is in the page — before a character has
been inserted — and it stays up through the insert, the send click and up to
four seconds of proving delivery. On the window path that is tens of seconds, in
which the panel said "typing the message" while the provider's composer, plainly
visible next to it, was empty. Reported as exactly that: *"it's showing like
typing but nothing is getting typed."* The wording names the phase now. The
underlying wait is the window path itself, and the fix for that is not a label —
it is `directTextRunnable` above, or a provider whose engine can carry the run.

**`ready` used to say "Provider window open" on a path that opens no window.**
The agent's stage track was written when there was one transport, and the direct
path emits the same `ready` — so every fast turn announced a popup, which is
indistinguishable from one actually appearing and was reported as exactly that.
Both sides now stamp `via` on every STREAM message (`direct` in
`direct/index.js`, `window`/`frame` in `attemptAsk`'s `record`, which is where
the ADAPTER's states pass through too — the adapter runs in the page and cannot
know there is another road), and `ui/agent.js` picks the wording from it. A
label naming something the user can go and look for has to be true, or it is
worse than no label.

**A chat the relay has answered once is on the relay for good, and that is worth
saying out loud.** `hasConversation` is URL-only and only the relay files a URL,
so one fallback — a stale token, a 403 cool-off, a turn carrying a file no
engine could take — pins the whole conversation to the window. That is correct
(the ids an API call needs cannot be recovered from a page, and a second thread
beside it would split the chat), and it is invisible: a run that has been fast
all week opens a window on a follow-up, and the only available reading is that
the extension has started doing something it was told not to. `run.js` emits one
step-0 note when `allowDirect && sameSession`, naming the cause and the way out
(New chat). Do not make it a per-turn notice — it is one fact about the
conversation, not about the step.

**The transport is chosen per provider, not once for the extension.** They do
not fail together: a meta.ai on Meta's newer frontend can leave its engine
useless while ChatGPT's is perfect, and one switch would make ruling out the
broken one cost the speed of the other three. `providerTransport` is that
choice. `DIRECT_PROVIDERS` in `providers/config.js` and the `ENGINES` map in
`direct/index.js` are two lists that cannot see each other — the options page is
a separate document and must not import background code — so an id in one with
no entry in the other is either a dropdown that silently does nothing or a
provider nobody can switch.

**Having an engine and being ON by default are two different things, and the
test is whether the engine covers the WHOLE surface.** `providerTransport`
absent used to mean direct, which switched all four on — and the two that only
carry text were the ones that made that wrong. ChatGPT and Gemini carry text, a
picture and a document, so every turn of every chat and every step of an agent
run can go the same way; the transport is decided once and never changes under
the conversation. Claude and Meta AI have no upload flow here, so the first turn
carrying anything is handed to the window — and a chat the relay has answered
once is on the relay for good (`hasConversation` is URL-only, and only the relay
files a URL). Defaulting them on therefore buys speed on the turns before the
first attachment and pays with a conversation that quietly changes character
halfway through, which is exactly the shape of failure the rest of this section
is about. `DIRECT_BY_DEFAULT` is that line, and `transportFor` reads an explicit
choice in BOTH directions — a stored `'direct'` has to beat the default list, or
switching Claude on in Options reads back as Popup and looks like a setting that
does nothing. `directStatus` also has to word the two cases apart: telling
somebody they "set it to Popup" when they never touched it both claims a choice
they did not make and hides that the engine is there, working, one dropdown away.

**One transport per thread. This is the whole of the correctness, not a
detail.** A provider-side conversation is either a URL a window is sitting in
or opaque ids only an API call can replay, and neither can join the other's. A
chat answering half its turns each way is two conversations pretending to be
one, and the model is never told where the gap is. Four guards keep them apart
and each closes a different door. A chat the relay already owns — any
conversation URL filed for it — is left alone entirely, which is also what makes
an upgrade uneventful: every chat already in progress carries on exactly as it
was. `fresh` is IGNORED on the direct path, because the panel derives it from
`hasConversation`, which reads URLs, and no URL is ever filed there — honouring
it restarts the conversation on every turn, which reads as an assistant with no
memory of the sentence before. A new panel chat gets a new session id, and that
is what genuinely opens a new provider thread. And an agent run never comes here
at all: a run is one accumulating conversation in which some turns carry a
screenshot, the direct path cannot deliver a picture, so those turns would land
in a different thread from the ones around them — the "finished · 0 steps"
failure this codebase has already paid for once. Dropping the picture instead is
worse: the message says one is attached. `allowDirect: false` is that decision,
and making it true means writing an upload flow per engine first.

For the same reason `hasConversation` must stay URL-only. Widening it to count
direct threads was tried: it makes `fresh` false for a relay turn with no URL to
resume, and `ensureProviderTab` with a null resume URL reuses the tab exactly as
it stands — so the question lands in whatever conversation that tab was left in.

**The reply is streamed, not buffered, and that is most of what "fast" means
here.** `await response.text()` works and is the obvious way to write every one
of these engines; it also throws away the only thing the user actually feels.
The first words are ready in about a second and the last twenty seconds later,
so buffering pays the full price of a slow answer and shows none of the
benefit. `stream.js` yields complete lines — a chunk boundary mid-line is held
back, and a multi-byte character split across two chunks is held with it, or the
answer gains replacement characters in the middle. Its `idleSignal` gives up on
SILENCE rather than on elapsed time: a deadline's most reliable victim is the
case it is not for, a long answer arriving perfectly well.

**"The stream carried no answer text" was one sentence for three failures.** It
is what ChatGPT's engine said whether the endpoint had changed shape, the body
was not an event stream at all, or the connection had produced nothing — and
those need three different responses, none of which can be worked out afterwards
without knowing what came back. `emptyStream` in `chatgpt.js` tells them apart
from what the reader counted. No events AND no body is a dropped connection,
which is worth exactly one more attempt: `retryable` says so and `withStaleRetry`
honours it WITHOUT forcing a token refresh, because the credential was never the
problem. It is set only when the request reached no conversation at all — past
that point a retry posts the user's message twice, which is worse than the error.
A JSON body instead of a stream is the endpoint speaking in its own words
(`{"detail": …}`), so those words are repeated rather than replaced by a guess.
Events with no text anywhere the reader looks is the shape having moved, and the
error names the top-level keys that DID arrive, which turns the next fix from a
bisect into five minutes. Under `strict` none of this falls back to a window, so
the sentence is the whole of what the user gets — it has to carry its weight.

**A citation the client could not resolve reaches BOTH roads, and `scrub` only
knew the delimited form.** `:contentReference[oaicite:0]{index=0}` is markup
ChatGPT's web client is supposed to turn into a source chip, and it involves
none of the private-use delimiters the rules below strip — so it passed through
untouched. Measured on a train-fares run, printed under the answer in the panel:
*"…and another ₹1,046–₹1,931. :contentReference[oaicite:0]{index=0}
:contentReference[oaicite:1]{index=1}"*. In an agent run it is worse than
cosmetic: the answer is a JSON string and this lands inside it, so it is saved
with the conversation.

It also reaches the WINDOW path, which the note below does not cover. That note
is true of the delimited spans — the client really does render those away — and
false of this one, which is precisely what the client leaves behind when a
citation fails to resolve. So it is in the DOM as ordinary text and
`htmlToMarkdown` carries it out faithfully. `scrubScaffold` in `adapter.js`
strips it in `nodeText`, the one place every reply passes through, streamed
deltas included.

That is a second copy of the same regexes, and this file cannot import — so
`tests/direct/scrub.test.mjs` lifts the copy out of `adapter.js` with a
`new Function` and drives it over the same table as `scrub`. The drift it guards
is silent in the worst way: one road clean, the other printing markup.

The bracket form `【oaicite:0†source】` goes too, and the DAGGER is what makes
that rule safe. Corner brackets appear in ordinary text — quoting Japanese,
naming a title — and a rule matching those alone would eat part of a real
answer. Nothing but a citation puts a U+2020 between them.

**The window path rendered ChatGPT's own markup away; the direct path hands it
to you raw.** Citations, file references and navigation lists travel in the
stream as spans delimited by private-use characters — U+E200 opens, U+E201
closes, U+E202 separates the parts. The web client turns those into the little
source chips under an answer, so nobody driving the page ever saw one. Reading
the endpoint means reading the text before that happens, and it only surfaces
once a turn does something citation-shaped, which is why a research task found
it and a year of ordinary questions did not. Neither symptom is cosmetic: the
panel prints `fileciteturn0file0L5-L8` at the reader, and in an agent run
the scaffolding is prose in front of the JSON block, so `parseAction` reports
"no action" and the run spends its misreads on markup the provider never meant
to send.

`scrub()` in `chatgpt.js` strips it, and the delimiters are NOT one
interchangeable class — treating them as one was tried and destroys answers. A
non-greedy ``[U+E200-U+E20F]`…`[U+E200-U+E20F]`` stops at the internal SEPARATOR,
which leaves the real closing delimiter behind, which the unterminated-tail rule
then matches to the end of the string: "Runway offers 125 credits on the free
tier" came out as "Runway offers 125 credits". Open and close are matched
specifically, the tail rule only fires when there is no close at all, and the
bare form (delimiters already lost elsewhere) is matched on its `turn<n>` suffix
with no leading word boundary, because it arrives welded to the previous word.
It is applied on the way OUT rather than into the accumulator: the raw text is
what the next delta appends to, and stripping a half-arrived span from the
accumulator leaves the closing delimiter landing on nothing. Write the ranges as
`\uXXXX` escapes — a literal private-use character in source survives until the
first editor, copy or re-encode that quietly drops it, and then the strip stops
working with nothing to see.

**Every engine finds the answer by scanning, and the framings disagree about
what a fragment is.** Gemini and ChatGPT's older shape REPEAT the whole reply in
every frame, so the longest wins — and longest rather than last, deliberately,
because trailing frames are routinely metadata or a short follow-up suggestion,
and taking the first match yields "Hello! How" in place of the paragraph.
ChatGPT's newer delta protocol and Claude's blocks APPEND, so they are
concatenated and treating a longer string as a replacement there loses
everything before the longest single fragment. Do not unify these: the shapes
are not ours to rely on, and both are live.

**A stale credential is the common failure and it is recovered from silently.**
The login outlives the twenty-minute session cache, and the fix is mechanical.
Only errors an engine has MARKED `stale` (401, or Gemini's 400) are retried
once with a forced refresh — an unmarked failure would otherwise be asked twice
and fail twice before the window is ever reached, at the cost of a second full
round trip. Sessions live in `chrome.storage.session`, which is memory-backed
and dies with the browser; ChatGPT's device id lives in `storage.local` on
purpose, because a value that changed on every restart would look far more like
automation than a browser does.

**A direct request has no page, and two places in `inflight.js` would assume it
does.** Its `tabId` is null, which one line down means "a background frame" — so
the heartbeat would tick the offscreen document four times a second for the
whole of every answer, and Stop would send a CANCEL into an unrelated embedded
request. `direct: true` skips the tick; `entry.abort` is checked INSTEAD of
`cancelAdapter`, not before it. They are alternatives, never a sequence.

**A silent fallback makes "why did a window open?" unanswerable, so the Options
page can ask.** Falling back without a word is right — the window answers, the
user gets their reply, and an error for something that did not go wrong is
noise. The cost is that the four fast providers and the eight slow ones look
identical from the screen, and when one of the four quietly stops being fast
there is nothing to look at. The reasons are all real, all different and all
invisible: signed out, a Cloudflare challenge, a region block, an endpoint that
changed shape, and — the one that actually turned up — a meta.ai on Meta's newer
"ecto" frontend, which is a different application with its own session cookie
and an API this engine does not speak. Reporting that as "signed out" sends you
to re-authenticate a session that was never the problem.

So every engine has a `probe()` beside its `session()`, and BOTH are built on
one `resolve()`. That is the part worth keeping: a diagnostic that works out the
credential separately from the code that uses it will eventually disagree with
reality, which is worse than having none. `probe()` also forces past the
twenty-minute cache — a stale success is exactly what a diagnostic must not
report — while `session()` still uses it, because a turn wants speed and a
diagnostic wants truth.

**The silent fallback is not only invisible, it is PERMANENT, and that is what
makes it worth a switch.** Falling back costs latency and nothing else — that is
the whole argument for doing it quietly, and it holds for exactly one turn.
What it misses is what happens next: the window that answered files a
conversation URL, `askDirect` sees `urls[provider.id]` on every later turn, and
the chat is on the window for good. So a single transient failure — a 403 from
ChatGPT's sentinel standing the provider down for five minutes, a token that
aged out, one turn carrying a PDF — converts into a popup on every question for
the rest of that conversation, minutes and hours after the cause has cleared,
with `New chat` the only way back and nothing on screen linking the two. Someone
who set a provider to *No popup* and then watched a window open on their fourth
question is looking at a setting that appears simply not to work.

Three things answer it. `declines` in `direct/index.js` records WHY the last
turn went the other way — every `return null` in `askDirect` goes through
`decline()`, so the reasons cannot drift from the code that produces them, in
the same way `probe()` and `session()` share one `resolve()`.
`directTransport: 'strict'` stops the fallback for providers set to No popup,
reporting that reason instead of opening a window. Three exemptions there are
load-bearing — an agent run (`allowDirect: false`, since most engines cannot
carry a screenshot and a run that refuses to start helps nobody), `scope:
'none'` housekeeping (it never opens a window anyway, and a red error over a
chat title nobody asked for is noise), and any provider with no engine at all.
`warmProvider` has to check it too: warming builds the window BEFORE the ask
decides, so leaving it out puts the popup and the debugger bar on screen for a
request that then refuses.

And strict does not merely refuse a chat the window has pinned — it LEAVES that
thread and carries on over the API. That is the pin's only real exit, and
without it the setting is worse than useless on precisely the conversations that
need it: refusing every question in a chat whose only sin is that a window
answered one turn an hour ago.

**Unpinning drops the URL and NOTHING else, and it has to tell the panel.** Both
halves were wrong first time round and each produced a new provider conversation
per question — the exact symptom the `sessionId` buckets exist to prevent,
reintroduced one layer along by the code meant to help.

Forgetting the ids as well is what New chat does, and it is not what this is: the
URL and the ids are two separate records of two separate provider conversations,
and a chat that already had an API thread before a window ever answered in it
still has one. Dropping that opens a third. So `forgetConversation` alone, then
read `getThread` and resume it if it is there.

And the panel keeps its own copy in `session.conversationUrls`, which
`SET_CONVERSATIONS` seeds back into the store on every tab switch. Seeding merges
with the store winning — but the store no longer HAS this key, so "the store
wins" resurrects it. Pinned again, unpinned again next turn, forever. So the
worker posts `CONVERSATION_DROPPED` and `messages.js` deletes its copy: both
copies go, or neither does.

The `notice` is emitted only when there was genuinely nothing to carry on from.
A conversation silently restarting is the invisible gap the
one-transport-per-thread rule exists to prevent, and the model cannot see what it
has lost — but warning about a gap that is not there is its own kind of noise,
and after the fix above the common case is a thread that continues perfectly
well.

**Naming a chat must not reach a window the chat is not in.** Housekeeping
carries no thread of its own — it joins the chat's — so when the chat is
API-owned there is no URL to resume, and `ensureProviderTab` with a null resume
URL reuses the relay tab EXACTLY as it stands: whatever conversation it was last
left in, quite possibly another chat's. The naming question lands there and the
provider titles that conversation after it, which is how a panel chat ends up
called "Conversation Title Setup" over a ChatGPT thread called something else
entirely. Under `strict` the title request is therefore skipped outright rather
than falling through to the window, on top of the existing rule that it may
never OPEN one.

**`strict` is the default, and reversing that default needed a migration.**
On paper `auto` is the kinder setting — the question always gets answered. What
that framing misses is that its cost is not one turn of latency but every later
turn in the chat, permanently, for the reason above. So the real choice is one
visible refusal against an unbounded number of invisible popups. Changing
`DEFAULT_SETTINGS` alone would have reached nobody who mattered, though: stored
settings win over defaults, so anyone who had ever pressed Save — which is
everyone who went to Options *because* windows kept opening — would have kept
`'auto'` forever. `TRANSPORT_DEFAULT_REVIEWED` in `state/settings.js` rewrites a
stored `'auto'` once and marks that it has. Rewriting a value somebody chose is
not something to do casually; it is honest here only because `'auto'` was the
sole option until `'strict'` existed, so a stored one is an inherited default
rather than a preference. Set it back afterwards and it stays back — the marker
is what guarantees that, so do not drop it.

**New chat forgets two records and builds nothing.** Starting over with a
provider is `forgetConversation` AND `forgetThread` — both, or the "new" chat
carries straight on from the old one, because the URL is what a window would
reopen and the ids are what a direct turn would send. What it must NOT do is
open a page. `NEW_CHAT` used to call `resetProviderTab` unconditionally, which
CREATES the relay window and navigates it — and the panel sends one of these per
provider, so pressing New chat or switching provider put a window and Chrome's
"started debugging this browser" bar on screen before a single question had been
asked, for a provider that was then going to answer over its own API and never
look at it. A window that already exists is still steered, because leaving one
sitting in the conversation you just walked away from is its own kind of lie;
one that does not exist is left not existing, and `attemptAsk` navigates at ask
time anyway if it turns out to be needed.

**Naming a chat must not build anything, and it must JOIN a thread rather than
start one.** `scope: 'none'` is housekeeping the user never asked for, and it
was the single most visible cost of the direct path — because it is the one
request that still went to the window. What appeared on screen was a whole
second UI: a relay window, Chrome's "started debugging this browser" bar over
it, and — since that request carried no `sessionId` and therefore had no thread
— a BRAND NEW provider conversation. So the user's own ChatGPT history filled up
with an entry called "Name this conversation. Reply with a title of AT MOST 6
words", one per chat they opened, all to fill in a label the panel was already
showing. Three things fix it and all three are needed: `panel.js` passes
`sessionId` so there is a thread to find; `askDirect` reads that thread under
the CHAT scope and refuses outright when there is none, because "no conversation
to join" is exactly how every provider is told to start one; and `askProvider`
returns `skipped` rather than falling through to the relay unless a window for
that provider is *already* open, where the exchange is free and is what this
feature was designed as. It also never writes the thread back — otherwise the
next real question continues from a discussion about what to call the chat.

**"Never ask" means never ask — and the one exception is the task's own words,
not the policy's.** The `ask` action was deliberately not gated on `policy`,
for a good reason written down beside it: "check with me before submitting" is
the USER's question, and a setting cannot countermand the sentence typed next to
it. What that missed is the other half. The model volunteers a confirmation
before anything that submits a form — the right instinct, and precisely what
Never ask exists to switch off — so a run set to unattended stopped dead on "May
I click Submit application?" and waited for someone who had already said they did
not want to be asked. A setting that silently does nothing is bad; one that does
nothing AND blocks the run is worse.

`mayAskUser(policy, task)` is where the two are told apart, and it lives in
`loop.js` because that is the only layer holding the task. Under any policy that
already stops for approvals, asking is fine. Under `auto`, only if
`WANTS_CONFIRMATION` matches — and it is matched against `instructionOf(task)`,
not the whole prompt, for the same reason `WHOLE_PAGE_TASK` is: a task is often
pasted material with the request at one end, and a CV containing the word
"confirm" would otherwise switch approvals back on for a run set to unattended.

It is enforced in two places on purpose. `closing()` tells the model up front
that nobody is watching, which is the fix — a refusal costs a full round trip
and the model usually just rephrases the question. `performAction` refuses
anyway, which is the safety net. The refusal must be an INSTRUCTION ("decide it
yourself… do not ask again") rather than a bare no: a run that spends its steps
rewording a question nobody will answer never finishes.

**A provider that pushes back is stood down, never retried.** A 429 or a 403 is
the provider saying, in the only way it has, that it does not want this right
now — and the obvious response, trying again, is the worst one available. It is
also the response every other error path here takes, which is why this needs its
own branch: `stale` (a 401, or Gemini's 400) means "the token aged out, mint
another", and that IS worth one retry. A 403 from ChatGPT's sentinel is not a
stale bearer and re-asking with a fresh token asks the same question twice.
`pace.js` therefore holds a per-provider cool-off, checked in `engineFor` before
the session is even resolved so a stood-down provider costs nothing — not a
token fetch, not a proof of work, not a request — and its questions go through
the window, which still answers them. `Retry-After` wins when the provider sends
one, capped at an hour so a punitive value cannot silently switch the fast path
off for a whole session. The Options page NAMES the state rather than reporting
"unavailable", because backing off is working correctly and reads as broken.

**The cool-off lived in worker memory, which meant it mostly did not exist.**
MV3 tears the worker down after ~30s idle and the gap between two questions is
nearly always longer, so a five-minute stand-down held in a module variable was
erased before it could ever expire: the provider said 429, the worker slept, the
next question rebuilt the module with an empty map and went straight back at it.
It read as working and was not there. The whole record now lives in
`chrome.storage.session` — past the worker, gone with the browser, which is
exactly the lifetime this wants. The cost is that `coolingFor` is a synchronous
read of a hydrated copy, so every entry point (`askDirect`, `directReady`,
`directStatus`) awaits `hydrate()` before `engineFor`. A cold read reports "not
cooling", which errs towards asking and corrects itself on the next turn.

The ladder escalates — 5, 15, 45, 120 minutes — because the flat version has its
own bad shape: refused, wait five, refused, wait five is a client returning at a
fixed interval to be told no, which is more conspicuous than the burst that
earned the first refusal and never lets whatever tripped decay. Strikes reset
after three clean hours, or the ladder is one-way and a rate limit from last
Tuesday still costs forty-five minutes today.

**Spacing bounds the rate and says nothing about the total, which is the number
that matters.** At one request a second, thirty seconds of agent run is thirty
requests, and no amount of jitter makes that look like somebody asking
questions. So `pace.js` also holds a rolling hourly count per provider: past
`SOFT_PER_HOUR` (45) the gap stretches toward 4× rather than failing, because
forty-five questions in an hour is a heavy but entirely possible day; past
`HARD_PER_HOUR` (110) the provider is stood down until the count rolls forward,
because that is not a number one person reaches by asking things and getting
there means something is looping. That stand-down is recorded as `budget` rather
than `pushback` — it is our decision, not the provider's, so it carries no
strike and does not escalate, and the Options page words it differently.

The gap itself is `(base + read) × volume × jitter`. `base` is 1.1s for chat and
2.6s for an agent run — the run is the volume path, forty back-to-back turns with
nobody reading anything in between, so it is where a wider floor buys most and
costs least (about a minute across a forty-step run, against provider turns of
ten to forty seconds each). `read` scales with the length of the PREVIOUS reply,
capped at 7s: the pause after a two-thousand-character answer should not be the
pause after "ok", because a person is reading in between. The jitter is
log-normal rather than uniform — measured medians 1.16s / 2.66s / 9.16s for
20 / 2000 / 20000-character replies — because real gaps between one person's
actions have a long right tail that a uniform band cannot produce.

**`safePacing` switches the holding back off, and deliberately does not switch
off the stand-down.** The two look like one setting and are not. Spacing and the
hourly ceiling are this extension's own caution about a rate nobody chose — they
are a fair thing for the user to decline on a provider they are not worried
about, and declining them is the answer to "why is my run slow". A 429 or a 403
is not caution: it is the provider having said no, in the only way it has, and
`coolOff` is reached by no setting for that reason. Off is also not zero —
`UNSAFE_GAP_MS` still serialises, because compare mode fans out to four
providers in one tick and two requests leaving in the same millisecond is a
burst that buys nothing when the answers arrive one at a time anyway. The hourly
count keeps being RECORDED while it is off, or the Options page under-reports
exactly the sessions that sent the most.

Be honest about what all of this buys. Fewer requests is the only part that
genuinely reduces exposure; the rest is shaping. And it must not grow into
something that tries to DISGUISE anything — no user-agent shuffling, no
proxying, no account rotation, no fingerprint work. Every request here is the
user's own session from their own browser, and the honest way to make that
welcome is to send less of it. There is deliberately no reset button: the only
reason to clear a cool-off is to go back at a provider that just asked to be left
alone.

**Stop must not claim more than it knows, and the slot must not outlive the
run.** Two halves of one dead end: press Stop, get the composer back, type the
next question, and be told *"An agent run is already going. Stop it first."* —
naming a button that is no longer on screen, in a chat that shows nothing
running. The panel was wrong first: `stopEverything` called `forgetRequest` on
the spot, which is the panel asserting the run is over when all it has done is
ask. A run only tests `signal.cancelled` BETWEEN steps and the step in flight is
a provider round trip, so for several seconds afterwards it genuinely is still
going — curtain up, tabs still grouped, worker still refusing a new one. So the
run stays live in `core/runs.js` and only AGENT_FINISHED clears it; what changes
is the LABEL (`markStopping`, `.stopping`), because "stopping" and "running" are
different news. Two escapes exist for a worker that never answers — a second
press, and a `STOP_GRACE_MS` timer — and both are deliberately the panel
overruling the worker rather than its first move.

The worker half is that `agentRun` was a slot no cancelled run ever gave back
promptly. `waitForStoppingRun` separates the two cases: a LIVE run still refuses
(two would fight over one provider conversation), a STOPPING one is waited for
and then taken over whether or not it has finished unwinding, because nothing it
has left to do can affect anything. That needs identity — the `finally` clears
the slot and calls `releaseControl` only if it still OWNS them, or the old loop
takes down the new run's curtain and scatters its tab group. The slot is also
claimed BEFORE the first await now: `resolveAgentTab` can navigate a tab and
wait five seconds for it to settle, and two AGENT_RUNs arriving in that window
both passed the old check and both ran. `cancel()` releases the curtain
immediately rather than leaving it up until the loop unwinds — Stop that leaves
the page unclickable for another ten seconds is indistinguishable from Stop not
working.

**A provider with no streaming marker will have its own answer stopped by the
next send.** `isStreaming` reads two selectors, and a provider that declares
neither — or declares a `stop` selector that does not match its button, which is
arena.ai — has no streaming signal at all. That is not cosmetic: `isStreaming`
is what keeps the next question out of a composer whose send button is
CURRENTLY a stop button, and on most chat UIs those are one control in one
place. Sending into a live generation therefore does not queue the question, it
CANCELS the answer. Reproduced in `tests/panel/arena-send.html`: the previous
reply came out as "The previous answer [Generation stopped]", which is the
string in the bug report. `replySize()` is the signal nothing can take away — a
reply being written gets longer — and it is `textContent.length` rather than
`nodeText` because this runs before every send and forces no layout. Paid only
when `streamingMarkerSeen` is still false and the thread already has a reply in
it, so it is free for ChatGPT, Gemini and Claude after their first answer.

**arena.ai's newest message is the FIRST child, and "the latest reply" meant the
oldest.** Its thread is an `<ol class="… flex-col-reverse">`, so CSS draws the
first DOM child at the bottom and document order runs newest-to-oldest. Half of
this was already known — it is why arena's `user` selector is empty, since the
anchored branch of `freshText` wants assistant nodes FOLLOWING the question and
in a reversed thread they precede it. What the note beside that missed is that
the FALLBACK has the same dependency: "newest assistant text" is
`nodes[nodes.length - 1]`, which is document order too. So every turn of an
arena run came back "Hello! How can I help you today?", the first reply in the
conversation, while the answer on screen was a perfectly good JSON action.
Nothing reports that as a failure — the text IS a real reply, it just belongs to
a question from ten minutes ago — so the loop read it as answering in prose
instead of acting, pushed back, got the same stale text, and finished in three
steps having touched nothing. `reversedThread` in `providers/config.js` and
`inThreadOrder` in `adapter.js` are the fix, declared per provider rather than
sniffed because `getComputedStyle` on a thread container is a layout read on the
reply loop's hot path. A reversed thread must still keep `user: []`: the array
can be reordered, the document cannot, so the `compareDocumentPosition` branch
stays wrong and has to be left unreachable.

**The "thought" is a caption, and nothing ever said so.** It is printed verbatim
as the one line under each step in the timeline, and the prompt asked only for a
real thought rather than a placeholder — never for a length. So it grew.
Measured on a LinkedIn run: *"The search control did not expose a search field,
while the embedded frame has a direct Jobs link; use that link to load the
actual jobs results page"* — 140 characters of reasoning as the label for one
click, eight of those in a row, and the thing you actually want at a glance
(what was clicked, and why) buried in the middle of each. Asked for in
characters rather than as "be brief", which does not survive contact with a
model mid-reasoning, and paired with a line saying to think as long as it likes
before writing it: the field is the caption, not the thinking.

**Read the URL before navigating, and an unreadable page is not evidence of
being in the wrong place.** Same run, and it cost the whole budget: the address
bar said `linkedin.com/jobs/` throughout, while the model spent four steps
clicking the "Jobs" nav link to reach LinkedIn Jobs, then clicked "Me" at a
guessed coordinate when that changed nothing twice over. The page had read as
unreadable on arrival, so it never registered as having arrived — and the URL at
the top of every observation was the one piece of evidence that said otherwise.
The failure is invisible from inside: clicking a nav link to the page you are
already on is a no-op, so nothing fails, nothing errors, and the loop's own
repeat detection sees two different element ids rather than one repeated action.

**A placeholder in the shape of a value gets copied.** The prompt's first
example carried `{"thought":"one short line on why", …}` and a model asked for a
JSON object returned exactly that. Measured: the task was "open my gmail, read
the top 5 unread messages" and the reply was that thought verbatim with
`"action":"click","id":12` — "I'm Feeling Lucky" on the Google homepage the run
had just opened, landing it on Google Doodles. A model that has copied the field
description instead of filling it in has not reasoned about the action either,
so the empty thought and the wrong click are one failure. Every example in
`protocol.js` now carries a real thought. The same run is why the prompt says to
`navigate` to a site the task NAMES rather than hunting for it through links:
the element list is a strong pull, it is the concrete thing in front of the
model, and nothing said an address is the shorter road.


**Known and pre-existing: a run whose transport changes mid-run splits its
thread.** `directRunnable` decides once, but any per-turn decline — an expired
session, and now a cool-off or a budget stand-down that lands mid-run — sends
that turn to the window while its neighbours went direct, which is the split
`allowDirect` exists to prevent. Uniform declines are safe (every turn takes the
window); it is a decline that STARTS or STOPS partway that hurts. Not introduced
by the pacing work and not fixed by it.

**A worker's request should not differ from the page's by accident.** A `fetch`
from a service worker sends `Origin: chrome-extension://<id>`, no `Referer`, and
`Sec-Fetch-Site: none`, where the page making the identical call sends the
site's own origin, a referer and `same-origin`. That difference rides on every
request and is trivial to log. `direct/headers.js` corrects it with SESSION
rules, and `tabIds: [-1]` is what makes that safe: a page's request has a tab id
and the worker's has none, so the rules match ours and cannot touch the
provider's own traffic — which matters most for `Referer`, where the real page
sends the conversation URL and overwriting it would change the site's behaviour
rather than ours. It is not about getting past anything; the cookie and the
token are what authorise the call, and they are the user's own.

**Do not add `Origin`-rewriting rules to `rules/frame-rules.json`. Use
`updateSessionRules` — the static version bricks the extension.** A POST from the service worker carries
`Origin: chrome-extension://<id>` rather than the provider's own origin, and
four `modifyHeaders` rules setting it per host — scoped to POST, so a no-op for
the site's own requests — look like exactly the right belt and braces. Chrome's
static-ruleset validator rejects them, and it does not reject them the way a bad
rule usually fails: the whole ruleset is refused with
`frame-rules.json: Internal error while parsing rules`, the MANIFEST then fails
to load, and the extension will not install at all. One unusable rule costs the
entire extension, not one feature.

It also bought nothing measurable. Every direct call is authenticated by a token
in the body or an `Authorization` header, not by its origin, so if an endpoint
ever does refuse ours the symptom is one engine failing — which returns null and
lands on the window path, which is the designed behaviour. Anything of this kind
belongs in `chrome.declarativeNetRequest.updateSessionRules` at runtime, where a
rejected rule is a caught promise instead of an extension that will not load.

**An engine with no credential needs MORE pacing, not less.** `notrack.js` is
the only one here with nothing to resolve — no sign-in, no bearer, no device
id, no proof of work, no captcha token. The page posts plain JSON to
`/api/dispatch` and reads an event stream back, so the whole session apparatus
the other four need is absent rather than omitted: `session()` answers a
constant, `probe()` is the only thing that touches the network, and nothing is
ever marked `stale` because nothing can go stale. That reads as the easy case
and is not. With no account behind a request the limit is applied per address,
which cannot be throttled politely — it can only be refused. Measured while
writing it: one question answered in 999ms, and the immediate follow-up came
back **429**. `pace.js` is what stands between that and a provider that stops
answering, and it is doing more work here than anywhere else in this folder.
The engine's job is only to hand it the right shape — `status` and
`retryAfter` on the thrown error, which is what `index.js` reads at the 429/403
branch.

That hole was real and general, not a notrack quirk: `gate` was reachable
only from `askDirect`, so the extension’s whole self-restraint covered one of
two roads to one host. An agent run whose engine cannot carry a screenshot —
Claude, Meta AI, notrack — takes the window for every one of its forty turns,
and the window path sent them as fast as a page could be driven. `askProvider`
now gates each attempt with the same `intent`, which also spaces the recovery
retries. `gate` only ever delays and cannot refuse, which is what makes it safe
on the road that exists to answer when the other one will not. Measured on
notrack: two requests at no gap → 429; six at the run gap (~3s) → all 200.

Note also what the reply shapes mean, because they disagree with the other
engines. `delta.chunk` APPENDS and `message.content` REPLACES that turn, and
both carry a `turn` number — so the reader keys on turn, concatenates deltas
within one, and lets a `message` overwrite them. Taking the longest, which is
right for Gemini's repeated frames, yields "PONGPONG" here. Turn 0 is the echo
of our own question and must be dropped: handing the user their own prompt back
reads exactly like a working reply.

**arena.ai is window-only, and that is not a gap waiting to be filled.** Its
chat POST carries a `recaptchaV3Token`, escalating to `recaptchaV2Token` — read
off `stream/create-evaluation` in its own bundle, and seen firing as an "I'm not
a robot" box inside the relay window on a real signed-in session. A token that
can only be minted by Google scoring a live page cannot be produced by a worker,
so an engine for it would fail every call and fall back anyway — slower than
having none. It is also why `providerMode: 'embedded'` is the wrong answer for
it specifically: a framed load scores worse, not better.

**Content scripts cannot use ES modules.** `src/content/*.js` and
`src/adapters/adapter.js` are classic scripts. They cannot `import`. To split
one, add another file to the same `js: [...]` array in `manifest.json` (they
share one isolated world) — and update every `executeScript({files})` call that
injects it. There are several.

**Inject both content scripts together, always.** A tab holding
`page-context.js` without `agent-page.js` answers page-context messages and
silently ignores the agent's, which resolves `sendMessage` to `undefined`
instead of rejecting — so nothing throws and no recovery fires. Every injection
site uses both files. See the comment in `agent/page.js`.

**Shipped skills and saved skills are two lists, joined on the way out.** One
stored list looked simpler and was not: `stored.skills || PRESETS` meant the
shipped set was only ever the empty state, so saving your first skill deleted
the other twelve. `lib/preset-skills.js` is data; `skillsHidden` in storage
remembers the presets you threw away, so an update can add new ones without
resurrecting one you did not want. The `/` list and the browse sheet read the
same `state.skills`, and `/` only fires when the slash is the whole composer —
matching it anywhere opens the list on "and/or", on 24/7 and on every pasted
URL, and while it is open it owns the Enter key.

**A skill carries files, and `filePick` decides whether you are asked which.**
A prompt alone is most of what makes a skill reusable and not all of it:
"tailor this CV to the job on screen" is the same paragraph every time and a
different PDF every time. Attaching that PDF by hand is the step people stop
doing, after which the question goes out without it — and the answer, written
about a document nobody sent, is exactly as fluent as the right one. So a skill
keeps its own files and says what to do with them: `'ask'` opens the picker in
`skill-files.js` (the résumé case, where the point is to choose), `'all'` arms
every one of them silently (the style-guide case, where choosing would be a
question with one answer). Five things are load-bearing. The files are sorted by
the composer's own `fileKind`, exported from `attachments.js` rather than copied
— a second copy of that regex drifts, and a `.pdf` sorted the wrong way is
attached as a page of replacement characters and looks like a file that arrived.
Nothing here is a new road to the provider: everything lands in `state.files` or
`state.upload`, which is what `ask()` and `AGENT_RUN` already send, so an
agent run gets the CV for free. Each armed file is stamped `fromSkill`, which
`syncTokens` reads when you rub `/resume` out of the box — a file nobody chose
on its own must not outlive the badge that carried it, which is the same drift
the badge layer exists to prevent, one layer along. Ticking a second upload
unticks the first, because there is one attachment slot and a picker that lets
you choose three PDFs and then quietly sends the last is a picker that lies;
`'all'` cannot ask first, so it says which one it took. And `ask()` closes the
picker on send: Enter belongs to the composer, so a question can go out with the
list still up, and the next file you ticked would then ride on your NEXT
question — which reads exactly like it having gone with the last one.

**A skill editor is a form, so it is not dismissed by a click elsewhere.** Every
other sheet in the panel is a menu: one click, one outcome, and closing it by
accident costs a click. The editor holds a prompt you are still typing and the
picker is the second half of a `/resume` already sitting in the composer, so the
document-level dismissal in `events.js` deliberately leaves both alone —
Escape, Cancel and ✕ close them. This also sidesteps the trap next door: a sheet
opened from inside another sheet's click handler is hidden in the same tick by
that dismissal unless the click is stopped. Editing a *preset* saves your own
copy and hides the shipped one, because `lib/preset-skills.js` is data in the
source and cannot be written to — the alternative is a form that accepts your
changes and discards them. `slugFor` takes the id being edited so a skill
re-saved without touching its command keeps it; without that it finds its own
slug taken and renames itself `/resume-2`, and the command you learned breaks
the next time you open the form.

**The provider pill and the provider sheet read the same variable, so both
repaint or neither does.** `state.active` changes in exactly three places, and
one of them was only repainting half the UI: opening a chat from history
switches to the provider that chat was held with, and `loadSession` called
`renderProviderSheet()` without `renderProviderPill()`. The pill went on naming
the provider you had left — it said "Gemini" while the tick in the list, the
question that went out and the answer that came back were all ChatGPT's. The
pill is the half that is always on screen, so it is the half that gets believed.

**A badge in the composer is text, and the text is the truth.** A mentioned tab
and a chosen skill were both real and both invisible: '@' put a chip in a row
under the box and left the "@job" you typed sitting in your sentence — nothing
ever called `clearMentionToken`, so the two things on screen describing one
choice disagreed — and picking a skill emptied the composer entirely, so a box
about to send four hundred words of instruction looked blank. `@[Job ad]` and
`/summarise` are now ordinary characters in the textarea, and `composer-ink.js`
paints a rounded background under those runs from a layer behind it. That is the
whole trick: the caret, selection, undo, IME, paste and Backspace-over-a-badge
all keep working because nothing about the control changed. A contenteditable is
the obvious alternative and the trap — it means reimplementing the caret
arithmetic in `mentions.js` and `slash.js` and inheriting every
paste-brings-its-own-markup bug. Five things are load-bearing. `syncTokens()`
rebuilds `state.contextTabs` and `state.skill` FROM the text on every keystroke,
never the other way round, so deleting a badge detaches its tab; a list
maintained alongside the text drifts, and it drifts towards "still attached, no
longer visible". The two layers only line up while their typography and box
model are identical — `font: inherit` on both, the same padding written twice in
composer.css, and a badge grown with a spread-only `box-shadow` rather than
padding, which would move the glyphs off the ones above them. The layer is
painted with DOM nodes, never `innerHTML`: labels come from page titles, which
are content we do not control. `expandTokens()` spells the badges out on the way
to the provider, or the answer talks about the brackets. And `labelForTab`
disambiguates duplicates by host — two tabs from one site are routinely called
the same thing, and two identical tokens are indistinguishable both to
`syncTokens`, which matches on text, and to the person reading their own
sentence back. The chip row survives only for a tab with no badge, because a
chip beside a badge saying the same thing is the same fact twice.

**A sheet opened from the + sheet must stop the click.** The document-level
dismissal in `events.js` runs after the row's own handler on the way up, sees a
click that landed outside the sheet it just opened, and hides it in the same
tick — Browse skills, Workspace and Select from screen all opened and vanished,
which reads as three missing features rather than one missing
`stopPropagation()`.

**No import cycles in the panel.** Three signals would create them, so they go
through `core/bus.js` instead: "ask this question again", "repaint the thread",
"the session list changed". If a new import would close a ring, add a bus event
with a comment saying why — do not rely on hoisting.

**A message animates on arrival, and only on arrival.** `patchAnswer` replaces
the assistant node on *every streamed delta*, and `renderThread` rebuilds the
whole conversation on a provider switch or a session reopen — so an entry
animation on `.msg` itself restarts several times a second (the reply strobes)
and replays a week-old chat as if it had just landed. `ui/thread.js` decides:
`.enter` is added only for a `turn:provider` key it has not painted before, and
never from `patchAnswer`. The same asymmetry runs through the scroll: the panel
follows the bottom with `behavior: 'instant'` while text streams — `.thread` is
`scroll-behavior: smooth`, and a smooth scroll restarted by the next delta
crawls along behind the text forever — and uses `smooth` only for the Latest
button, where the travel is the point. Both live in `ui/scroll.js`, which exists
because `thread.js` already imports `agent.js` and putting them in either would
close an import ring.

**The wait states are a protocol, not a label.** `connecting` (the request has
started), `ready` (the provider window is open and the adapter is in the page)
and `submitted` (the adapter has *proved* delivery) are three different failures
when a run parks on one, and the panel's stage track shows which. `ready` is
posted by `transport/ask-provider.js`; adding a state means adding it to every
list of pending states — `PENDING` in `ui/thread.js` and the one in
`finishIfIdle`, which releases the composer and would otherwise let go early.

**The highlighter escapes what it emits; nothing else escapes it.**
`lib/highlight.js` runs on RAW code and escapes each token as it goes, so
`lib/markdown.js` hands fenced blocks over *before* its own escaping pass. Doing
it the other way — colouring text that is already escaped — means matching
regexes against `&lt;` and `&amp;`, and one token that spans an entity turns a
provider's answer into markup in the panel. It is a scanner, not a parser: it
will never know a keyword is being used as a property name, and it does not
need to.

**`sidepanel.css` import order is the cascade order.** It is not alphabetical.
Three pairs of files depend on it and are listed in that file's header. Adding a
stylesheet is free; *reordering* the list is a visual change.

**An observation describes the topmost dialog, not the page behind it.** When
`agent-page.js` finds a modal it indexes only that modal's controls and returns
its text, and `observation.modal` says so. Widening it back to the whole document
brings back the failure it was written for: a site opens an Easy Apply dialog
whose buttons live at the end of the document, a document-order list capped at
`MAX_ELEMENTS` is therefore all background nav, and the model — unable to see the
Submit — re-clicks whatever opened the dialog until the run dies. For the same
reason the element cap is spent on what is on screen first, then on off-screen
controls whose label matches the task, and `observation.omitted` reports the
rest.

**Page text is keyed on `{url, modal}`, not on the URL.** A dialog opening
replaces everything a page says without touching its address, so a URL-only
"already sent this" check leaves the model reading the article behind a modal it
cannot see. `sentTextFor` carries both halves and the page decides staleness
itself, in one round trip.

**A deep read walks its own scroll targets, not the scrollbar.** `stepDown()` in
`page-context.js` keeps the position it *intends* each pane to be at and marches
that, then puts the pane back on the mark before harvesting. Rewriting it as
"where we are now, plus a screenful" reintroduces the bug it was written for: a
virtualised list re-renders on every scroll event, a re-render that empties its
container for an instant collapses the scroll height, the browser clamps the
position, and one step can land at the bottom. The walk then agrees it has
finished — two passes, the first screenful and the last, nothing in between.
Measured on a 25-item list: jobs 1-8 and 19-25, with 9-18 missing and no sign
anywhere that they had been skipped.

**A list page is the first screenful until something scrolls it.** This is the
single biggest source of confident wrong answers, because a partial extract
reads exactly like a complete one. Three things guard it and they are separate:
`capture.js` reads deep for a question the user sends (not for the preview chip
— that would scroll their tab while they type); `loop.js` reads deep for the
*first* observation when `WHOLE_PAGE_TASK` matches the task, because the model
cannot ask for something it has not yet seen; and the model can ask for
`{"action":"observe","deep":true}` at any point. Removing any one of them leaves
a path where "apply to five jobs here" acts on the two that happened to render.

The trigger is tested against the **instruction**, not the whole task, and it is
vetoed by `SINGLE_TARGET_TASK` unless a set of items is actually named. Both
halves are paid for: a task is often pasted material with the request at one end
of it, and a CV supplies "all", "total" and "list" by itself — so "«CV» fill the
form" scrolled LinkedIn to the bottom and spent four provider round trips
transcribing 15,000 characters before touching the form. "Fill in all the
fields" is one form; "apply to the first five jobs" is five, and only the second
needs the page whole. Note also that the numbers people actually type are words:
`A_NUMBER` matches "five" as well as `5`, and until it did, the example this
entire path was written around matched nothing.

**A deep observation is transcribed before it is decided on.** 45k characters
handed to one turn gets skimmed, and a skim is indistinguishable from a reading
— same fluency, same confidence, ten missing items. `agent/read.js` sends it
part by part for extraction only, then the loop hands the deciding turn the
notes (`PAGE NOTES`, not `PAGE TEXT`). The chat path does the same in
`transport/deep-ask.js`; they share the scan prompt and the splitter in
`context/prompt.js` but not the loop. The heading also has to say that the
numbered elements are only what is on screen — given a complete inventory and
nothing else, a model treats all 25 items as clickable.

**Every agent turn ends with `closing(task)` — including the first.** The first
turn is the longest message of the run (rules, task, then up to forty thousand
characters of page) and it used to be the only one that did not end with the
format instruction. So the last thing the model read was a list of jobs, it did
what a list invites and described them, and the run opened with "Reply was not
an action" before it had done anything. `closing()` puts the task and the demand
for a single JSON block at the end of *every* message, where recency works for
us. Do not inline it back into one branch: the two ends drifted apart once
already, and the symptom appears one layer away from the cause.

**A picture the provider refused is worse than no picture at all.** Every layer
reports success — the capture worked, the turn completed, the reply parsed — and
only the provider's composer knows the file was dropped. Meanwhile the message
the model answered says "a screenshot is attached", so it reasons about an image
it never saw. Measured on a Naukri run against Gemini: two undelivered captures,
then `click_at (194, 301)` — coordinates invented for a screenshot that did not
exist, landing on the wrong control. `run.js` now carries the adapter's
`attached` flag back to the loop as `imageDelivered`, and one failure sets
`blindProvider` for the rest of the run: `visionReason` stops firing and the
explicit `screenshot` action declines BEFORE capturing, because photographing a
page and then failing to deliver it costs a tab activation and a paint wait for
nothing. What it returns instead is the load-bearing part — it says out loud
that no image was seen and not to guess coordinates, since a bare failure just
gets retried. `imageDelivered` is `null` when the turn carried no picture, which
is not the same as false and must not be read as one.

**`parseAction` is lenient on purpose.** The reply comes out of a chat window,
not a function-calling API, so nothing in the path enforces a schema and every
drift lands as "could not read an action" — a wasted round trip, sometimes
repeated. Nested action objects, `"index"` for `"id"`, `click_element`, an
unclosed fence, a trailing comma, smart quotes and an unquoted key are all
shapes that were observed, not hypotheticals — the last of those was
`{"x":212,y:338}`, a perfect `click_at` in which the model quoted every key but
one, and the run answered "could not read an action". `quoteBareKeys` is a
scanner, not a regex, and that distinction is the whole of it: the obvious
version quotes any word followed by a colon after `{` or `,`, which reaches
inside string VALUES — models write `"thought":"go to a, b: c"` constantly — and
rewrites them into nonsense. It tracks whether it is inside a string (honouring
backslash escapes, or `\"` ends the string in the wrong place and the rest is
scanned as structure) and only quotes a word in key position. It still refuses
to invent intent: no
action-shaped object means no action, and `loop.js` decides what that means —
one slip is corrected with the element list re-sent and an example built from a
number that is actually on the page (a bare correction leaves the model nothing
to apply it to), two in a row means it is answering rather than acting and its
prose becomes the answer — with a line saying nothing was clicked, because a
run that only ever observed and then described the page reads exactly like one
that did the work.

**The markdown instruction created a JSON bug, and it cost whole runs at the
finish line.** `finish` carries the answer in `"answer"`, the prompt asks for
headings, bullets and a table — and a model writing a document does not write it
as one line with `\n` between the paragraphs. It presses return. `JSON.parse`
rejects a raw control character inside a string outright, so the one reply that
finally had the answer in it came back as *"Could not read an action from that
reply"*: `MAX_MISREADS`, run over, work discarded, with the finished answer
sitting in a reply nobody could read. Measured on the exact shape the prompt asks
for — a heading, a table and four bullets — `parseAction` returned no action at
all. The note beside that instruction used to say `parseAction` "has to guess,
which it can". It could not.

`repairStrings` in `parseLoosely` is that guess, now that one exists. Raw
newlines, tabs and other control characters inside a string are escaped, and so
is the unescaped inner quote that comes with prose (`"answer":"it says "free
tier" here"`) — a `"` closes the string only when the next non-space character is
one that can legally follow one (`:` `,` `}` `]` or the end), and anything else
means the model was still writing. The heuristic loses on `"see "https://x.com",
it says"` and does not try to win it: that fails to parse, which is what happened
before, so nothing is lost.

Two things about the shape of `parseLoosely` are load-bearing. The attempts are
ORDERED with the untouched text first, so a repair can only turn a failure into a
success and never rewrites something that already parsed — that property is what
makes it safe to keep adding to the list. And `repairStrings` is tried alone
before `normaliseSyntax`, because the two disagree about curly quotes:
straightening `“…”` is right when the model typed the object's own delimiters in
prose and wrong when they are quotation marks inside the answer, and an answer
asked for in markdown is full of them. Alone-first keeps them curly in the case
that only needed the string repair; the combined attempt is the last resort,
where recovering the answer with straight quotes beats losing the run.

`tests/agent/action-json.test.mjs` drives the whole journey — the reply a
provider sent, through `parseAction`, into the HTML `lib/markdown.js` produces —
because "it parsed" is not what is being asked for.

**One turn may carry several actions, and the first failure ends the batch.** A
provider round trip is ten to forty seconds, so a strictly one-action loop spent
one of those per form field — nearly all of it re-deciding what was already
decided when the form was first read. `parseAction` therefore returns
`actions[]` (`{"actions":[…]}`, a bare array and `"steps"` all parse), capped at
`MAX_BATCH_ACTIONS`, truncated at any `finish` because a model that says it is
done and then queues three more clicks has contradicted itself and stopping is
the safe reading. The loop runs them in order and abandons the rest the moment
one fails or the tab changes: every action in a plan was aimed at ids from one
observation, and the commonest reason one fails is that an earlier one replaced
the page. What goes back is the *numbered* list of what ran — a batch that
filled four fields and failed on the fifth reads as a single failure if only the
last note returns, and the model then redoes the four that worked. A batch is
still **one** step: `MAX_STEPS` bounds round trips, which is what a run's cost
and the user's patience are actually made of.

**Agreeing is not doing, and `finish` used to take the model's word for it.**
Asked for the hardest star pattern, a run replied "Yes, I got it. A 'very
hardest' pattern WOULD BE a Swastik, Butterfly, Rangoli…" — acknowledged the
task, described the work, changed nothing, finished. Three turns went that way
in a row, and from the panel every one reads as success: a confident paragraph
over a green "Agent finished". Nothing else in the loop can catch it — the reply
parsed, the action was valid, no step failed, no misread fired. So the finish
branch tests `acted` (was one thing typed, clicked or submitted all run?) AND
the wording, because a run that only ever had to READ something must still be
able to end; `PROMISED_RATHER_THAN_DID` matches the promising and acknowledging
shapes ("I got it", "would be", "let me", "I can") and deliberately not past
tense, which is the tell of work that actually happened. One push-back per run:
more and a model with genuinely nothing to do argues for the rest of the run,
none and "yes, I got it" ends the task. It is not counted as a step, like every
other re-ask. The prompt carries the same rule next to `finish` itself, because
the guard is the safety net and the instruction is the fix.

**Answering the question is a different mistake from getting the format wrong,
and one correction cannot serve both.** A research-shaped task — "find the free
video tools, compare them, give me a table" — is one the model believes it
already knows the answer to, so it writes the answer out and waits to be
thanked. Nothing was opened, nothing was read, and every claim came from memory
while the browser sat on the starting page. The generic correction makes it
worse: told to "send the block itself", a model in that state either wraps the
same paragraphs in JSON or reaches for `finish`, because from where it is
standing the work is done.

**Length is the wrong test for it, and was tried.** A 400-character threshold
looks generous and is not: the reply that prompted this was 197 characters —
"Here is a deep analysis of the top Free AI Video Generation Platforms in 2026,
breaking down their free-tier limits, watermark rules…" — an opener and a table,
which is what these actually look like. Anything low enough to catch it also
catches a fumbled action. What separates the two cases is whether the model was
REACHING for an action at all, so `answeredInsteadOfActing` tests for an
`action` key in any shape `parseAction` forgives (`LOOKS_LIKE_AN_ATTEMPT`) and
keeps length only as an 80-character floor against a stray sentence. `acted`
still guards it, so a run that has been working and fumbles one turn gets the
format correction. That test selects a correction that NAMES it: you answered
from your own knowledge, nothing has been opened, do not repeat the analysis and
do not finish. The example goes with it — `firstFieldId` prefers something that
can be typed into over whatever happens to be first in the element list, because
on a search page a `click` example points a stuck run sideways while a `type`
with `submit` is the move it actually needs. It returns null rather than
guessing: an example naming a field that is not one is worse than no example.
The step description says which of the three it was, since a cut-off reply, an
answer from memory and a format slip render identically as "no action" and need
three different responses from whoever is watching.

The push-back is the safety net; the fix is in `closing()`. Correcting this
afterwards costs a full provider round trip and frequently does not take — the
model has already convinced itself — so the block repeated every turn now says
outright that its own knowledge is not an answer here, and that with nothing
opened yet the next action is a search or a navigation, never prose. Same
division of labour as `mayAskUser`: tell it up front, refuse it anyway.

**A re-ask is not a step, and the step note carries the reply.** `loop.js`
counts `step` up only when a reply actually carried an action, because a
formatting fumble used to cost one of the run's forty steps and finish the task
short — punishing the user for something the next turn corrects. Termination
does not rely on that counter: `misreads` ends the run after `MAX_MISREADS` in a
row, unconditionally, so that branch must never fall back into the loop. The
note also quotes what came back, because a refusal, a page summary and a reply
truncated mid-code-block otherwise render as the same sentence in the panel and
call for three different responses.

**A reply with an odd number of ``` markers is not finished.** `adapter.js`
refuses to settle on one, because settling mid-block hands the loop half a JSON
action and it comes back as "Reply was not an action" — a parser complaint for
a transport bug. It gives up after `OPEN_FENCE_GRACE_MS` regardless: some sites
render the closing fence somewhere `nodeText` never returns, and waiting on it
forever would turn a cosmetic DOM difference into a five-minute hang. When one
gets through anyway, `parseAction` returns `truncated: true` and the loop asks
for the *same action* again rather than re-teaching the format — a model that
got the format right and was cut off mid-render will happily argue about JSON
for three turns if you let it.

**Nothing announces the end of a reply, so it is inferred — and a pause looks
identical.** Every signal `adapter.js` settles on is sampled: the stop button
vanishes for a frame whenever the provider re-renders its composer, and a
provider that stalls mid-sentence is, for that instant, indistinguishable from
one that has finished. Sampled *time* does not rescue it — `idleFor` is
measured from the last change we happened to see, so in a throttled relay
window (one poll a second) a single mid-stream sample already clears a 600ms
threshold. Measured, that is how "Hi! How can I help you?" reached the panel as
**"Hi! How"**, with no error and nothing to suggest it was a fragment. Three
things fix it and they are separate: `AGREEING_POLLS` consecutive reads of the
same text, `AGREEING_POLLS` consecutive reads with no streaming marker, and a
`CONFIRM_MS` wait plus one more read *before committing* — if it grew, that was
a pause and the loop goes round again. The confirm is charged once per reply,
not per poll, and it goes through `sleep(ms, ms)` rather than a bare
`setTimeout` so a worker tick can still land it on time in a throttled window.
Do not trade it back for latency: a truncated reply is indistinguishable from a
short one once it reaches the panel, so nobody can tell it went wrong.

The conversion itself is not the suspect here, and it is worth not re-suspecting
it: `htmlToMarkdown` has been checked against ChatGPT's real code-block markup —
hljs span soup, the `json` language label, the copy button — and returns clean
fenced markdown that `parseAction` reads. The failures are truncation and
genuine refusals, in that order.

**The loop takes screenshots on its own, and rations them.** `visionReason()` in
`agent/loop.js` attaches a picture when the element list has stopped explaining
the page — a step that failed, one that left the fingerprint identical, or the
same action twice — and the capture happens *before* the observation that ships
with it, so the numbered elements describe the image. Vision is capped at
`MAX_AUTO_LOOKS` per run: a screenshot costs a tab activation, a paint wait and a
large share of the turn. Do not make it unconditional.

**A file goes into a page through `DataTransfer`, and the model must be told so
in the same breath as being told typing cannot work.** `input.value` is
read-only for file inputs and script cannot open the OS picker, so a model
handed only `type` and `click` alternates between them and finishes with "the
browser cannot programmatically select a local file" — true, and useless, since
the extension is holding the user's file as bytes the whole time. Measured on a
job application: a typed path, a click on "Choose File", two screenshots and a
refusal, with the CV attached to the run throughout. `upload` sets `input.files`
from a `DataTransfer`, which is the one route the platform allows, and needs no
permission the extension does not have. Three things around it are load-bearing.
The listed element is almost never the input — a styled uploader hides the real
one behind a button or a label — so `fileInputFor` walks from what the model
could see to the thing that takes the file, and stops at the enclosing form
rather than the document, because the next `input[type=file]` up the page
belongs to a different control and attaching a CV to the wrong field looks like
success from every angle. Both `input` and `change` are fired, in that order: a
plain listener wants the second, React and Vue bind the first, and firing one
leaves half the web with `files` set and a UI still reading "no file chosen".
And the bytes ride on the action from the background — the model names the
field, never the data — because a base64 CV in the prompt is most of a turn.
Unlike the provider-side attachment this is NOT claimed and spent: a form can
legitimately want the same document twice.

The prompt must not offer `{"type":"file"}` as an `ask` field until one exists.
`askFields` downgrades an unknown type to `text`, so promising it produces a
text box, a typed path, and precisely the failure above — with the model
believing it did the right thing.

**Typing into a chooser is not filling it in, and it ends the batch.** A combo
box, an autocomplete, a "select one" — typing filters a list, and the value
only exists once one of the options has been *clicked*. So a plan of
`[type into the combo box, press Save and Continue]` submits an empty field,
and the form says "is required and must have a value" for something the model
can see it just typed. `opensAChooser` in `agent-page.js` recognises the
control by role and ARIA (`combobox`, `aria-haspopup`, `aria-autocomplete`,
`aria-expanded`, `aria-controls`) — a static property, so there is no race with
a list that renders a tick later — and the result carries `opened: true`.

ARIA alone is not enough, though, and the case that proves it is the one this
was written for: Workday's source picker is an `<input placeholder="Search">`
with **no role, no aria-expanded and no aria-haspopup** — nothing an
accessibility-shaped test can see. What it has is
`data-uxi-widget-type="selectinput"` inside
`data-automation-id="multiSelectContainer"`, because its own test suite needs
those. So the check also matches `data-*` attributes against
/(multi)?select|combobox|autocomplete|typeahead|dropdown|picker|prompt|lookup/.
Data attributes **only**: `class` looks tempting and is a trap, since Tailwind
ships `select-none` on half the elements of a modern page and every batch would
stop on the first field it touched.
`loop.js` abandons the rest of the plan there, because nothing after it was
planned against a page that had the list in it. The RESULT then has to *say*
so: a batch of two that stops after one produces the single-line RESULT branch,
which said nothing about the dropped action at all — the model saw "typed into
[14]" and no reason its submit had vanished.

**Three screenshots, because they cost three different amounts.** `screenshot`
is one capture of the viewport. `scope:"full"` is one capture *per screenful*,
stitched in the worker with `OffscreenCanvas` — there is no DOM there, and an
offscreen document for one paste-up would cost more than the captures. Adding
`load:true` walks the page to the bottom and back first, for the lists that only
render what you have scrolled past. The model chooses; making every screenshot a
full one would put four seconds in front of "is the button enabled yet".

Two things about the stitch are not optional. Tiles are placed at the scroll
position the page **actually reached**, never the one that was asked for: a page
is rarely a whole number of viewports, so the browser clamps the last scroll to
`scrollHeight - innerHeight`, and pasting that tile at the requested offset
slides it down by the difference — the bottom of the image repeats a band and
loses the real end of the page (measured: a 250px page came out 300px tall with
a duplicated strip). And the captures need ~560ms between them, because
`captureVisibleTab` is rate-limited to about two a second and *throws* rather
than queueing. `MAX_FULL_SHOTS` bounds the rest: past six screenfuls a stitched
JPEG is a slow upload for a picture the model downscales anyway.

**"Did the app take the file?" cannot be answered by counting children.** An
image attachment lands several levels inside the composer, adds no text, and is
not a `blob:` URL — so a check built on direct children and `innerText` saw
nothing change, read a paste that had *worked* as a failure, and let the next
route attach the same screenshot again. Two thumbnails, one question, and a
"could not be handed to ChatGPT" notice on top of it. `shape()` counts
descendants and pictures, and all three tests — recognisable preview, filename,
shape — poll *together* rather than one after another, or every provider whose
markup we cannot name costs the full probe. Measured on the shape that failed:
2 uploads and a false failure notice before, 1 upload and success after.

**Every screenshot needs its own filename.** A run sends many, and ChatGPT
answers a second `screenshot.jpg` with a modal — "You've already uploaded this
file" — instead of an upload. The modal then covers the composer, so the *next*
turn cannot be typed either: one refused attachment killed the rest of the run.
`asAttachment` stamps a bare data URL with `screenshot-<base36 time>.jpg`, and
`attachFile` treats that dialog as success and dismisses it, because "you have
already uploaded this" means the provider has the file. The dismissal is gated
on the wording and the click stays inside that dialog — a rule loose enough to
press buttons in any modal would eventually press one that matters.

**A description object evaluates every branch.** `plan()` in `agent-page.js`
built one object literal of summaries, so the `click_at` line — which reads
whatever is under the point — ran for *every* action, including the ones with no
point, where `elementFromPoint(NaN, NaN)` is null. Every `type` and `click` in a
run then failed with "Cannot read properties of null (reading 'getAttribute')",
reported as if the step itself had gone wrong, one layer away from anything
mentioning coordinates. It is a `switch` now, and `labelFor` returns `''` for a
missing element rather than throwing — callers legitimately reach it with a
point that hit nothing or an element that has just been removed.

**`el.click()` is not a click, and the element you listed is not the one that
listens.** Two separate reasons the agent could not touch a Workday option list,
and both had to be fixed before *any* of it worked:

A browser click is `pointerover`, `pointerdown`, `mousedown`, `pointerup`,
`mouseup`, `click`. `el.click()` dispatches the last one alone, and Workday's
option rows — like most menus, comboboxes and drag-aware controls built out of
divs — commit on `pointerdown`. They ignored it completely, which is why every
route into that list appeared to do nothing at all. `press()` sends the whole
sequence, ending with `click` so native activation behaviour still fires: the
browser walks up from the event's target to find it, which is also why
dispatching on an inner span still submits its form.

And the listed element is a `role="option"` **wrapper** whose handler sits on a
child (`data-automation-id="promptLeafNode"`). An event dispatched on the
wrapper never reaches it — events go up, not down. So `clickElement` takes the
element's centre, asks `elementAtPoint` what is innermost there, and presses
that, exactly as a real click's target is the innermost element under the
cursor. `contains` keeps it honest when something unrelated covers the point.

Measured on the real markup: the rows were in the element list the whole time
(`[2] option "Social Media not checked"`), `wrapper.click()` chose nothing, and
the same id through `clickElement` fired the handler — on `promptLeafNode`, the
child. Ordinary controls are unaffected and fire exactly once: submit → 1
submit, checkbox → checked, anchor → navigated.

**Typing accepts a coordinate too, and that is the half that makes the escape
hatch work.** `click_at` can reach a control the numbered list cannot address;
without `{"action":"type","x":…,"y":…,"text":"…"}` the model could then focus a
field it still had no way to fill in. `fieldAtPoint` looks for the field *on*
the point, then the field *around* it, and only then inside the element that
was hit — and that last step is bounded hard, to a non-document element under
200px tall. The obvious version is a trap: `body.querySelector('input')` answers
"the first field on the page" for a coordinate that hit nothing, so a miss
silently types the address into the name box. It did exactly that once; now a
miss says so and nothing moves.

**The model can click a point, not just a number.** `{"action":"click_at",
"x":520,"y":554}` aims at the screenshot, whose size is stated in the
observation's `VIEWPORT` line — without it a coordinate is a guess, since the
model has no other way to know what a pixel of the picture is worth. It exists
for what the numbered list cannot reach: an option drawn into a portal at the
end of the document, a canvas control, a widget with no role and no label. It
dispatches the whole pointer sequence (`pointerdown`, `mousedown`, `pointerup`,
`mouseup`, `click`) rather than `el.click()`, because a menu built out of divs
usually commits on `pointerdown` and ignores a bare click — measured on a
Workday-shaped fixture: `option.click()` chose nothing, `click_at` chose the
option, filled the field and closed the list. The approval prompt and the risk
test both name what is *under* the point rather than the coordinates, or
"Click at (520, 554)" is a confirmation nobody can judge.

It must never use `elementFromPoint`. The curtain is a full-screen element with
`pointer-events: auto` and it is up for the whole of every run, so that call
answers "the agent's own overlay" every single time — the ring drew, the ripple
played, the cursor pressed, and the click landed on our blocker. `elementAtPoint`
takes the whole `elementsFromPoint` stack and returns the first entry that is
not ours. Anything else that reaches into the page by coordinate has the same
problem and should use it.

**The agent has a pointer, and it is one element that moves.** A ring appearing
around a field says something happened there; a cursor travelling to it says
*the agent* did it, which is what someone watching their own browser fill itself
in is actually asking. So `moveCursor` transforms a single arrow between targets
rather than painting a new highlight each time, and `press` dips it with a halo
on a click. The move is **never awaited**: 220ms of travel per action is 1.8s on
an eight-action batch, and slowing the agent to animate it would be paying real
time for a decoration. It lives in the overlay's shadow root with everything
else, so `agentHighlight` turns it off, the capture veil hides it, and
`releaseControl` removes it — an arrow left on a page nothing is driving is
worse than no arrow at all.

**A form that rejects the same submit twice gets photographed, on its own
budget.** None of the other vision triggers fire on this shape and that is the
whole problem: the click *lands*, the page *does* change (an error banner
appears), and no two consecutive actions are the same — so `visionReason`
returned null while the run pressed "Save and Continue" five times against the
same two validation errors. Text cannot settle it either, because the element
list shows a field with a value in it, and a field with a value in it and a red
error under it are the same line. `FORM_REJECTED` counts observations carrying
a *validator's sentence* — "Errors Found", "is required and must have a value",
"please correct" — never the bare word "required", which every form on the web
marks its fields with and which would put a screenshot in front of every step.
Two in a row triggers a capture, and the message that goes with it says to read
the error and fix the field it names rather than press submit again. It has its
own allowance (`MAX_ERROR_LOOKS`) because a form fight starts ten steps in, by
which time `MAX_AUTO_LOOKS` is usually spent. Measured on the run this came
from: three captures before, all explained as "the page is identical to before
that step" — true of the element list, false of the page, and useless to the
model — against four after, each naming the rejection.

**A skill is an agent, and using one pays the person who wrote it — but a
payment may never block an answer.** That second half is the whole design.
Signing means a wallet popup and a chain round trip, so `chargeForSkill` is
started after the turn exists and is NEVER awaited: the question is already on
its way, and a panel that cannot answer until a payment clears has traded its
only product for a feature. Every failure path therefore ends in the question
being asked anyway, and each returns a REASON rather than throwing — a skill
nobody registered is free, an unreachable marketplace is free, a wallet on the
wrong network is free, a declined signature is free. A missing registry entry
must never mean "charge something".

**The client never decides the split, because it would have every reason to
lie.** The percentage and the company address are read server-side per request
and are not inputs to anything the extension sends. The panel receives an
unsigned transaction group and signs it; `assertMatches` in `api/_lib/algorand.js`
re-decodes the SIGNED bytes and checks sender, receiver and amount against a
quote the server re-derives from the database. Skipping that check would not
show up in testing: a client can sign any transaction it likes, and without it
the server would submit one paying the client's own address, watch it confirm,
and write a receipt saying the developer was paid.

It is also why the extension builds no transactions. It has no bundler and no
dependencies, so it cannot carry algosdk, and hand-rolling msgpack, base32 and
SHA-512/256 in a panel script to move real money is not a trade worth making.

**Two payments, one atomic group.** Algorand groups either land entirely or not
at all, so there is no state where the developer has been paid and the company
has not. That makes a receipt describe one event. A zero company share produces
a ONE-transaction group rather than a two-transaction group with a zero leg —
the chain would accept the zero payment and charge a second 1000 microALGO fee
to move nothing.

**Money is integer microALGO everywhere — the wire, the database, the panel.**
Never a float and never NUMERIC. ALGO has exactly six decimals, microALGO is the
atomic unit, and `0.1 + 0.2` is not `0.3`. The integer split has to give the odd
microALGO to someone and it goes to the DEVELOPER: rounding the company's cut up
takes from the person who did the work, and dropping it leaves a microALGO
unaccounted for, which makes the receipt fail to reconcile — and a receipt that
does not add up is the one thing this whole path exists to prevent. There is a
price floor (0.02 ALGO) because below it the network fee is a larger share of
the transfer than the developer's cut.

**A receipt is written only after the chain confirms.** No pending row that
later turns real. A row in `receipts` means the money moved and
`confirmed_round` is the proof anyone can check without asking us — which is
also why every leg in the panel links to a public explorer. A receipt you can
only verify by trusting its issuer is not a receipt.

**Every response pays, and "which skills are payable" was the question that
stopped that being true.** `loadListing` was called with the panel's own skill
ids — `?ids=p-summary,p-table,…` — which is a fair optimisation for a panel that
only ever charged for skills, and became a silent kill switch the moment
anything else was billable. The registry also carries one entry per agent ACTION
(`act-navigate`, `act-click`, …), so `priceOf('act-navigate')` was null for every
step of every run, `noteAction` dropped all of them, and `settleRun` reported
"nothing billable" — no error anywhere, because a missing registry entry
legitimately means free. Measured: a two-step Gmail run finished with a green
"Agent finished · 2 steps" and no receipt at all. The listing is now the whole
catalogue and takes no argument, because a filtered one is indistinguishable
from a catalogue whose missing entries are free.

The other half is `act-answer`. Charging only for runs and paid skills means the
ordinary case — a question, an answer — produces no receipt, and billing that
fires on some answers and not others reads as billing that is broken. An answer
is work: the question went to a provider through the user's own session,
streamed back and was rendered. It is noted per PROVIDER (`noteAnswer` in
`run-billing.js`), because compare mode fans one question out to four and gets
four answers back, and one charge for four is exactly the lump sum the per-leg
receipt exists to replace.

Where it settles is load-bearing. `noteAnswer` files a line on every `done` in
`onStream`, and `finishIfIdle` signs them — that is the only place that knows a
REQUEST is finished rather than one of its answers, and settling per answer
would put four wallet prompts in front of one question. It reads the owning
session BEFORE `forgetRequest`, which is what knows it, and never
`state.session`: the panel follows tabs and an answer routinely lands for a
conversation that is no longer on screen. It is still not awaited. An error, a
login wall and a cancelled question all settle through the same branch and none
of them is billed — charging for a question that produced nothing is the one
thing a receipt must never do.

`settleRun` also checks the wallet's chain against the listing's, which
`payForSkill` has done since it was written and this path never did: a TestNet
quote signed by a MainNet wallet fails at submission with an error that says
nothing about why.

**"Nothing was charged" and "something should have been charged and could not
be" are different facts, and the block used to draw neither.** The rule it is
built on is right — a chat where nothing was charged shows NOTHING, because an
empty "fees: none" under every answer trains people to stop reading the place
the real numbers appear — and it does not cover a charge that was ATTEMPTED and
failed. Every reason in `attemptSettle` is something the user can act on: no
wallet connected, a wallet on the wrong chain, a declined signature, a
marketplace that is down. All of them were dropped on the floor by the `void` at
the call site, so a run that should have been billed and was not looked exactly
like a run that was free — which is how the bug above survived.

`recordDecline` in `ledger.js` files the last one per conversation, in memory
rather than storage: it describes an attempt, not a payment, and writing
failures to disk beside the receipts would make the ledger look like a record of
money that moved. A landed receipt CLEARS it, or the block contradicts itself.
The one reason never recorded is `NOTHING_TO_BILL` — no priced items with a
price list that loaded fine, which is a free tool working correctly. That
distinction is why `listingMissing()` exists in `x402.js`: "this id is not
priced" and "there are no prices" produce identical silence one layer up and
need opposite responses.

The decline row is drawn through `textContent` like every other value in that
block, and `tests/panel/receipts.html` drives a hostile reason string through it
for the same reason it drives a hostile tool label — a wallet's error message is
a string from an injected object on a page we do not control.

**`receipts.css` referenced `--text` and `--text-dim`, which do not exist.** The
tokens are `--fg` and `--fg-dim`. Fourteen declarations, every dimmed line in the
fee block, all inheriting body colour instead — the one surface whose whole job
is being read carefully was drawing its supporting detail at full weight. Worth
knowing because CSS fails silently here: an unknown custom property is not an
error, it is an unset value, so nothing anywhere reports it.

**The fee block is built with the DOM, never `innerHTML`.** A tool label comes
from a developer's registration and an address comes off the wire; both are
content we do not control, and this is the one surface in the panel where
getting that wrong puts attacker-supplied markup next to a wallet address.
`tests/panel/receipts.html` drives a hostile label through it in a real browser
for exactly that reason — a fake DOM cannot reproduce the bug, because the bug
is the parser doing what it is told. The block also renders NOTHING when nothing
was charged: an empty "fees: none" under every answer trains people to stop
reading the place the real numbers appear.

**A 404 is a dead link, and it used to be diagnosed as an unreadable page.**
This is the single most expensive thing a research run does wrong, and no layer
could catch it: a 404 loads perfectly well — the navigation succeeds, the DOM is
there, no step fails — and what it *is* is short and decorative, a headline and
an apology over a background image. That is exactly the fingerprint
`unreadableReason` was written for. So the loop photographed it, learned
nothing, and told the model "an embedded document or frame with no readable
text", which reads as *try again* rather than *this URL does not exist*.

Measured on "Best AI coding assistants 2026": 25 steps, ~8 minutes.
`zapier.com/blog/best-ai-coding-assistant/` is a 404, and the run opened it four
times and spent three screenshots on it (22s, 17s, 16s) out of a whole-run
budget of six. The identical Google query was navigated to three separate
times. Meanwhile `read_url` had returned one of the real articles in **0.2s**
and was then abandoned for tab-opening.

Four things fix it and they are separate. `deadPage` in `loop.js` runs BEFORE
`visionReason` — the order is the whole of it, since a 404 matches
`unreadableReason` and whichever runs first decides. It tests wording AND
length together: "went wrong" and "not found" appear in ordinary prose
constantly, so the words alone condemn a real page, and a genuine error page is
short where an article about error pages is not. `photographed` keys on
`url\nreason` so the same page is never shot twice for the same reason — with
`rejected >= 2` exempt, because a form fight means the page genuinely CHANGED
and the second picture carries a new error banner. A skipped capture is not
silent: `pageWarning` says why in words, or the observation looks identical to
the one before it, which is the state the model answers by repeating itself.
And `visited` is a per-run ledger restated by `closing()` every turn, carrying
the VERDICT rather than just the URL — "already visited" alone invites a
re-check, "dead link" is what closes the door.

**A reading task is told to read, on the turn it is choosing how.** `read_url`
was already in the vocabulary and already said "prefer it over navigate" — and
the model reads that once, at the top of a very long first message, then spends
the run opening tabs. `RESEARCH_TASK` in `loop.js` puts it in `closing()`
instead, which is repeated every turn, for the same recency reason as every
other rule here that appears twice. The batching half is what actually buys the
time: a batch is ONE provider round trip, `read_url` ends no batch (it sets
none of `failed`, `opened`, `frameChanged`, and does not move the tab), and a
round trip is ten to forty seconds against a fetch of about two hundred
milliseconds. Five sources read in one turn instead of five is most of a
research run. The trigger is matched against `instructionOf(task)` for the same
reason `WHOLE_PAGE_TASK` is — a pasted CV supplies "compare" and "research" by
itself — and it is deliberately narrow: a form-filling run steered onto
`read_url` would not be slow, it would be wrong.

**A page the DOM cannot describe is photographed, not guessed at.** Text
extraction fails silently: a chart, a map, a slide, a scanned or embedded PDF
and a canvas app all come back as an observation with almost no text, which is
indistinguishable from a page that really is empty — and a model handed that
either invents a plausible answer or finishes apologising about a page that was
full of what it needed. So `agent-page.js` counts what reading cannot reach
(`observation.visual`: canvases, large images, video, frames, and how many
characters there were) and `unreadableReason()` in `loop.js` turns "short on
characters AND heavy on pixels" into a capture. Both halves of that test matter:
characters alone fires on every page mid-load, pixels alone on every article
with a hero image. Small images are skipped for the same reason — every page has
icons. This one runs **before the first decision** as well as inside
`visionReason`, because the post-step trigger is one turn too late for a run
that *starts* on a dashboard, and `renderObservation` says out loud what the
silence means so the model knows the page is not empty, only unreadable.

**The survey and the first action are ONE turn, not two.** The route used to
cost a provider round trip of its own that was forbidden from carrying an
action — the prompt said "Reply with the plan and NOTHING ELSE", and anything
JSON-shaped arriving there was discarded. That is ten to forty seconds in front
of every planned run, spent producing prose, while the model already had the
page, the stitched picture and the task in front of it. Measured on the run
that prompted this: 29s of `Working out a plan` before the first click of a
seven-step task, with a second full round trip after it to get that click.

Nothing justified the split. The observation the survey reads IS the
observation the first acting turn reads — same page, same numbered ids, and
nothing happens in between for a second trip to discover. So `SURVEY_FORMAT` in
`plan.js` asks for the route, then the first batch, then the notes, and
`closing(task, plan, { survey })` swaps its usual "ONE fenced block and nothing
else" demand for it. Measured on the same three units of work: **4 round trips
→ 3** (`tests/agent/survey-turn.test.mjs`).

Five things hold it up. The ORDER inside the reply is the same reasoning that
already put `## Notes` last — a truncated reply loses its tail, so the route
goes first because it shapes the actions, the block second because it is the
half the run cannot continue without, and the notes last because nobody is
blocked on them. `closing` must swap the demand rather than append to it: a
model obeying the last thing it read writes the block alone, the route is lost,
and every later turn runs planless — the old failure, one layer along.
`harvestPlan` runs BEFORE `parseAction`, so a reply that surveyed properly and
fumbled its JSON keeps its route and gets the ordinary format correction
instead of being asked to survey again. `surveying` is cleared by ANY reply for
the same reason. And `planFrom` refuses a reply with no headings at all: that
is a bare action, and storing its one-line `thought` as YOUR PLAN would replay
one turn's throwaway reasoning forty times as the route the model supposedly
checked against a picture of the whole page.

`routeOnly` is the other half of the same saving. `closing()` repeats YOUR PLAN
every turn — deliberately, for the reason below — but the notes underneath it
are up to twenty lines of site trivia gathered on that turn only because the
page happened to be in front of the model, and they exist for the bubbles the
PAGE shows during the waits. Repeating them into forty prompts is ballast in
front of the two lines that matter. `notesFrom` still reads the full reply, so
the two halves simply go to the two places that want them.

Everything below still holds, and is why the survey is worth taking at all:

**A run surveys the whole page and writes a route before it touches anything.**
Without it a run is forty independent decisions, each made from one screenful
and none aware of the others — which is what makes an agent feel slow even when
every step is right: the model re-derives "this is an application, there is a
form, the submit is at the bottom" on every turn and pays a full round trip, ten
to forty seconds, to arrive back where it already was. `plan.js` spends one turn
up front on a *stitched whole-page* screenshot plus the page text, and the route
that comes back is carried into every later turn by `closing(task, plan)`. The
picture has to be the stitched one: a route decided from the top of a form does
not know there are three more sections below the fold, and a plan that stops
where the fold does is the one that finishes halfway with a confident summary.
Text goes with it because half of what a plan needs is a label the model must
name exactly, and small type does not survive a stitched JPEG being downscaled
by the provider. Three things about it are load-bearing. It is called YOUR PLAN
and repeated every turn — the model's own reasoning handed back, which it argues
with far less than an instruction from outside, and a plan it can no longer see
is a plan it has stopped following. It is context, never a script: the loop
never enforces a step, because pages lie and a plan followed off a cliff is
worse than none. And it is the reason `MAX_BATCH_ACTIONS` could go to 16 —
batching from one screenful is guessing about the back half of your own plan,
batching from a checked route is executing; raising the cap *without* the survey
buys longer replies and more of them truncated mid-render. Everything in the
path is best-effort and falls through to a planless run, which is what this loop
did before and still works: a survey is worth a round trip, not a run.
`worthPlanning` skips it for a single short imperative ("click the apply
button") — forty seconds of preparation for a two-second job — and the test is
deliberately narrow, because the cost of skipping a plan on a real task is far
higher than the cost of planning a simple one. Note `captureFullTab` answers
with `{dataUrl, screenfuls, capped}` while `captureTab` answers with a bare data
URL, and `ask` takes the bare one; handing it the object attaches nothing and
says nothing about it.

**The top-frame guard was in ONE of the two content scripts, and the other one
is the one the user can see.** `agent-page.js` has refused an untargeted
broadcast from a subframe since frames were added, for the reason written below.
`page-context.js` never did — and it looked safe for the same reason it looked
unnecessary: it is declared on the top frame only. What that misses is
`reachFrames`, which injects BOTH scripts into every subframe the moment an
agent run starts, because the agent has to see a form inside an iframe. From
then on, for the life of that tab, every `EXTRACT_CONTEXT` is a race any frame
can win.

Measured on a LinkedIn run: the context chip read *Sharing "reCAPTCHA" —
www.google.com · 12,000 chars* on a tab showing LinkedIn Jobs. A Google
reCAPTCHA iframe had answered first, so the page "shared" with the model was an
invisible challenge widget from a different origin — and the only thing on
screen that said so was the chip, because it names the document it read. Every
answer after that was about a page nobody was looking at.

The guard is one line and it must be the FIRST line of the listener: placed
after a branch it protects nothing, since the branch above it has already
answered from the wrong frame. `tests/content/frame-guard.test.mjs` lifts the
line out of both files and drives it, and asserts the ordering — the scripts are
classic and cannot be imported, so the alternative is finding out in a browser
six weeks later. Nothing sends `EXTRACT_CONTEXT` to a specific frame, so "top
frame only" is exactly what the chat path wants; the pickers want it too, since
they draw an overlay across the viewport.

**An iframe is a document the agent is not in, and its absence has no symptom.**
widget, payment box or booking calendar contributes nothing to the element list
— and nothing anywhere says it was left out. The model is handed a
complete-looking page, cannot find the field it was told to fill, and reports
that the page has no such field, which is a confident and checkable-sounding
lie. `frameCensus()` now lists the meaningful frames (visible, over 120px, so
trackers and ad slots stay out) and `renderObservation` names them
*unconditionally* — the visual census only speaks for a page under 220
characters, which is right for a chart and exactly wrong here, since a job board
with the application in a frame is thousands of characters of readable listing.
`use_frame` goes in and `{"frame":0}` comes back out; every page message then
carries that frameId. Three things are load-bearing. Injection is on demand via
`reachFrames`, not `all_frames` in the manifest: declaring it would put
`page-context.js` into every ad slot on every page, and the chat path broadcasts
to a tab with no frameId, so each becomes another racer for the reply that is
supposed to describe the page you are reading. The content script therefore
answers an untargeted message only from the top frame — `frameTargeted` is set
by the background whenever it passes an explicit `{frameId}`, and without that
guard an ad iframe can win an observation. And frames are matched to the census
by **URL, not position**: Chrome does not promise the order `executeScript`
returns results in, and "probably document order" silently sends a `use_frame`
into a tracking pixel. `currentFrame` is cleared on every navigation, tab switch
and followed popup, because a frameId belongs to one loaded document.

**A step says what it put where, and the timeline animates on arrival only.**
`Typed into "that field" at (1165, 201)` is three numbers and no information —
it tells you an action happened, not whether the right answer went in the right
box, which is the only thing anyone watching a form fill itself in is asking.
`shownValue` and `fieldName` in `agent-page.js` put the value and a recognisable
field name into both the plan description and the result note; passwords are
masked by input *type*, never by guessing at the label, because "PIN", "secret"
and "passcode" are all fields whose type says password and whose label does not.
The panel then picks the quoted parts out into `.agent-value` — built with the
DOM, not an HTML string, since that text comes from a page we do not control by
way of the model, and `innerHTML` there turns a field's placeholder into markup
in the panel. The timeline obeys the same asymmetry as the thread: `patchAgent`
rebuilds the whole list on every emitted step, so `.enter` is added only for a
step index this run has not painted before — put it on `li` unconditionally and
the list strobes several times a second and a reopened run replays a finished
task as if it were happening now. Exactly one continuous animation is allowed on
screen and it is the *current* step's marker; `failed` is a square rather than
only a different colour, because colour alone is not a signal everyone receives.

**The side panel cannot be made per-tab. Do not try again.** It is per window,
and `setOptions({tabId, enabled:false})` looks like the way to fix that — it is
not. Disabling **closes** the panel, and re-enabling does not reopen it, because
`sidePanel.open()` requires a user gesture and nothing in an extension can
supply one. Every path back is therefore a manual click on the icon. That was
merely annoying when switching tabs by hand and fatal during a run: `captureTab`
has to foreground the tab it photographs, so the panel closed a second after
every task started, which read as "I send a message and the sidebar disappears".
Chrome's own Gemini panel is a browser feature and is not bound by this. Two
further traps came with the attempt and are worth knowing before anyone retries
it: taking over `action.onClicked` (needed, since a disabled tab ignores the
icon) makes opening the panel depend on the worker being alive, and
`openPanelOnActionClick` is a setting Chrome *remembers* — so one failed worker
start left an icon that did nothing and no way into the extension at all; and
`setOptions` defaults every tab to enabled from the manifest, so disabling only
on activation leaves the panel on every tab not yet visited. What is per-tab is
the **conversation** (`openTabSession`), which achieves the actual goal without
any of this. `state/panel-tabs.js` is now only the marker: which tab the open
panel is attached to, moved on activation, removed when the port disconnects —
which is a trustworthy "the panel closed" signal again precisely because nothing
else closes it any more. It also re-enables the panel globally on start, to
unstick a profile left over from the build that disabled tabs.

**Two states, one line: attached, and driving.** `AGENT_PANEL` draws a still
`.topline.idle`; `AGENT_CONTROL` draws the animated one with the curtain behind
it. They must never both be up — two gradients in the same three pixels, and the
idle one showing through a run says the opposite of what is true — so
`drawPanelLine()` is the single decision point and both `takeControl` and
`releaseControl` call it. The favicon dot is shared between them and is only
handed back when neither wants it. The distinction is the point: the panel being
attached is ambient and takes no clicks, while a run stops the page responding
to you, and before this there was no mark for the first state at all — the panel
looks identical on every tab, so "is it reading this page or the last one?" was
unanswerable from the screen.

**A conversation belongs to a tab, and the binding is not on disk.** Switch
tabs and the panel switches with you, so the thread in front of you is always
about the page in front of you — one shared thread meant asking about a job
posting, moving to your inbox, and being shown the job questions above a page
they no longer describe, with the next question going to the provider on top of
that history. The chats themselves stay in `storage.local`; the tabId→sessionId
map lives in `chrome.storage.session`, and that split is the whole point.
Chrome hands out tab ids from zero again after a restart, so a binding kept on
disk would sooner or later give a brand new tab somebody else's chat — same id,
different page, a history nobody could explain. Session storage is wiped when
the browser closes, which is exactly the lifetime a tab id has. Every hand-swap
of `state.session` (history, New chat, delete) has to call `bindCurrentTab`, or
the next tab switch reverts to the old binding and the chat you just opened
vanishes with nothing on screen to explain it.

**A run belongs to a conversation, not to the panel — and that is what lets you
walk away from one.** `onActiveTab` used to skip the swap entirely while
anything was in flight, for a real reason: every message from the worker was
looked up in `state.turns`, which is whichever session happens to be open, so
moving the thread underneath a run left its steps painting into a conversation
nobody was looking at. The cost was paid by the user for minutes at a time.
Open a tab mid-run and the panel kept showing the agent's chat about a page you
had left, with a composer locked by work happening somewhere else — which is
most of what "it takes my browser over" actually means, and it was a panel bug
rather than an agent one. `core/runs.js` fixes the cause instead: ownership is
recorded when the request starts (`trackRequest`) and read back when its
messages arrive (`requestTurn`, `sessionOf`, `isVisible`), so a run paints into
ITS conversation whether or not that conversation is on screen. Four things
hang off that and none is optional. Every handler in `messages.js` ends at
`landed()`, which repaints a visible chat and *persists* an invisible one —
before this the whole timeline lived only in panel memory until the run ended,
so a run you switched away from and came back to had nothing to show. The
composer is DERIVED, never switched: `syncComposer()` re-reads `liveIn(the
visible session)`, and every hand-swap of `state.session` has to call it or the
blank chat on your new tab inherits the previous chat's Stop button and cannot
be typed into. `state.busyReq` and `state.agentRunId` survive as "what is
running in the chat you are looking at", which is what Stop acts on — scoped
deliberately, since a button under one chat's composer must not cancel a run in
another. And `ui/running.js` is the price of the freedom: a run nobody can see
is worse than a frozen panel, so one line says where it went, with a louder
state for a run blocked on an approval, because that one will never finish on
its own. `requestTurn(null)` must return nothing — `t.agent?.runId ===
undefined` is true of every ordinary chat turn, so an id-less message would
otherwise attach itself to an unrelated question.

**A tab you cannot read is still a tab.** `user-tabs.js` used to announce only
when the URL was ordinary, so activating a new-tab page, Settings or the Web
Store fired nothing at all — the panel never heard about the switch and kept the
previous page's conversation on screen. That is the worst reading available to
the user: they open a new tab expecting a clean slate, get the old chat, and a
"Page unavailable" notice underneath proving the panel knew the page had
changed. So `announceTab` always fires and always carries `tabId`, with `tab`
null when there is nothing to read, and `onActiveTab` binds the session on
`tabId` — never on `tab`, which is what the old early return did. The two halves
are genuinely separate: the SESSION follows the tab, the page CONTEXT follows
what is readable. `lastUserTabId` therefore still tracks readable pages only,
because it answers "which page goes in the prompt" and a chrome:// tab is not an
answer to that. `state.tab` may now be null in the panel; it is write-only and
nothing dereferences it, while `state.tabId` — the one the composer sends with a
run — is set by `openTabSession`, which is exactly what this restored.

**The agent drives its own tab and the tabs that open out of it — nothing
else.** `open_tab` is the agent's own doing and already routes through
`onTabChange`. The other half is a tab the *page* opens: a `target="_blank"`
link, "Continue on the employer's site", an OAuth popup. Chrome opens it
silently, the original is left showing a page that has finished its part, and a
run that never noticed spends the rest of its steps re-reading it — from the
panel, indistinguishable from the agent hanging. `watchOpenedTabs` follows it,
gated on `openerTabId` being a tab this run already controls: a tab the user
opens for themselves mid-run has no opener among ours, and stealing it would
curtain a page they went to on purpose. It is picked up *between* batches, never
during one — an action mid-flight holds a tab id it captured when it started,
and swapping that underneath it sends the message to the wrong page. The
listener is torn down by `releaseControl()`, which is the one thing that already
runs on every path out of a run.

**`openerTabId` says a tab came out of a page we are driving. It does not say
the agent opened it.** Ctrl+click, middle-click and "open link in new tab" all
set it too, so the follower took the tab the USER had just opened, curtained it
and moved the run onto it — they went to read something for thirty seconds and
came back to find the agent had moved in. `agentOpened` in `page.js` is the
missing half, and the reasoning is elimination rather than detection: a page can
only open a tab in response to a click, the curtain eats every trusted click for
the whole run, so a tab appearing while the agent is mid-action is the agent's
and a tab appearing in the ten-to-forty-second wait between actions is yours.
`duringAction()` marks that window — a counter with a trailing grace, because a
`target="_blank"` tab is created a beat after the click, and it has to wrap the
`settle` as well as the dispatch or the run's own new tab is filed as yours.
`open_tab` and `navigate` are wrapped for the same reason. A tab that is not
claimed is left *completely* alone: not followed, not curtained, not grouped —
and `loop.js` says so in the timeline once, because a run that silently ignores
a tab you are now looking at is indistinguishable from one that never noticed.

**A new tab goes where the user can see it, and `tabs.create` will not do
that on its own.** With no `windowId` it uses the LAST FOCUSED window, and
the relay is `type: 'normal'` on purpose (a popup holds one tab and Chrome
will not reliably place others in it) — so it is an ordinary window as far as
that rule is concerned, and it is focused the instant a provider tab is
created or navigated in it, which is every turn of a windowed run. `open_tab`
therefore put the run's pages in among the provider tabs. Three failures at
once: the user cannot see them; `isRelayOwned` is true of them, so the run is
then refused the very page it just opened; and creating a tab in a MINIMIZED
window RESTORES it, so the relay is dragged onto the screen with Chrome's
"started debugging this browser" bar across the top. What that looks like is
what it was reported as — *"the tabs are getting opened [in] the
ChatGPT-opened Chrome, not the Chrome for the chatting window"* — a second
browser the user did not open, running their task inside it.

`createUserTab` in `state/user-tabs.js` is the one road now. There were three
copies of this decision and only the agent's start page got it right, which is
the shape of bug a shared helper exists to prevent: the panel's "open this
conversation" — a tab whose entire purpose is to be READ — had it wrong too.
It prefers the window of the tab the new one belongs beside (`nearTabId`), then
a focused window of theirs, then any non-minimized one, because popping open
the user's own minimized window is the same rudeness one size smaller. The
move-it-back branch is belt and braces for Chrome placing a tab somewhere
other than the window it was asked for, which `relay.js` has guarded against
in the other direction for as long as it has existed.

`tests/agent/new-tab-window.test.mjs` models Chrome's actual rule, so a bare
`tabs.create` really does land in the relay there — asserted first, because a
fake that cannot reproduce the bug proves nothing about the fix.

**Chrome puts a new tab in the group the active tab is in, and during a run that
is one of ours.** Nothing in the extension did this and the extension got the
blame: press Ctrl+T mid-run and your fresh tab was swallowed by the agent's
group, coloured as the agent's, filed under somebody else's task. `guardGroup`
in `session-tabs.js` ejects a tab that was CREATED into our group and that
`agentOpened` does not claim — created only, on `tabs.onCreated`, with a
re-check 80ms later because Chrome sometimes reports the group on the created
tab and sometimes assigns it a tick after, and a guard handling only the first
left every Ctrl+T tab where it was. A tab you *drag* in afterwards is
deliberately left alone: that is a gesture with an obvious meaning — you are
handing the agent a page — and the two must not be confused. The eviction test
is `agentOpened` rather than "is it already controlled", because `open_tab`
creates its tab before anything can take control of it and the guard would throw
out the run's own new page.

**The group is named after the task and coloured by the chat.** "AI agent" on
every group answered a question nobody was asking — you know it is the agent,
the tabs are curtained and the panel is open — while the thing you cannot tell
from the tab strip is WHICH task those three tabs belong to. The colour is
hashed from the panel session, so a conversation keeps the same one across the
tasks you give it; a per-run rotation is movement that means nothing. Red, grey
and yellow are excluded: the first reads as an error on a group you did not
make, the other two are the lowest contrast Chrome draws. The title carries
fixed-width dots while the run works and a hand while it waits on you, which are
different states rather than different volumes — and fixed-width because a title
that changes width reflows the tab strip on every tick. The pulse is a worker
`setInterval`, which is otherwise forbidden here; it is allowed only because it
starts in `gatherTabs`, stops in `scatterTabs` and `endTabSession` — both on
every path out of a run — and a run holds the keep-alive open for its whole
duration anyway. Groups are still dissolved when the run ends: other extensions
in this space leave one group per session behind and they pile up until you
clear them by hand.

**A run may work on the tabs it was given and nothing else.** "Take the details
from @[Job ad], check them against @[My CV], fill in @[Application]" is one task
across three pages, and the run used to get one of them: `AGENT_RUN` carried a
single `tabId` — `contextTabs[0]` — and the rest arrived only as page text, so
the model could read three pages and act on one. It would describe the form it
had been asked to fill in. `tabIds` now carries all of them, `resolveWorkingTabs`
in run.js turns them into a closed set, and `mayUseTab` in loop.js is that set
plus whatever the run opened itself (`isControlled`) — the second half is not
optional, or `open_tab` produces a page the model is then refused permission to
return to. `switch_tab` checks ownership BEFORE `isUserTabId`, which only asks
"is this an ordinary page we could drive" and is true of the user's inbox and
their bank; asked the other way round, a tab that does not exist and a tab that
is not ours gave the same "not available, use list_tabs", which reads as
transient and invites trying another number. `list_tabs` answers with the
working set rather than the browser, because the old answer was an invitation
the model took. Every given tab is curtained and grouped at the START of the
run, not when it is first used: they are the agent's for the whole run, and a
page the user believes they have lent out must not look identical to one they
have not. `closing()` restates the set every turn through the single `tail()`
helper in loop.js — the same reason the task and the plan are restated, and the
same drift that once left the first turn without the format instruction. It
lists TITLES, because the user writes "fill in the application" and never the
number Chrome assigned, so a bare list of ids leaves the model matching names
against numbers and guessing. It is omitted entirely for a single-tab run, where
it would only invite switching to nowhere.

**The agent takes the screen only from someone who is already watching it.**
`captureVisibleTab` photographs the active tab of a window, so the loop used to
activate whatever it wanted to see — several times a run, since most of a run's
pictures are its own idea. For anyone who had switched to a tab of their own,
that is the page they are reading being yanked away and handed back a second
later, repeatedly, with nothing explaining it: the single most intrusive thing
this extension does, spent on a screenshot. `userIsWatching()` in page.js
decides, and it asks whether the FOCUSED window's active tab is one the run
controls — a run's tab sitting active in a background window is not something
anybody is looking at. When it is false, `captureTab` and `captureFullTab`
decline and the run carries on from text, and `followFocus` does nothing. When
it is true the run brings its next tab forward on `switch_tab`, because
following an agent that reads one tab and types into another is incomprehensible
if the screen never moves — the timeline says "Typed into Full name" and the
page in front of you did not change. Note what needs no permission at all: a tab
that is already active in its own window photographs fine even when that window
is behind another, so a run in a background window is unaffected. Unknowable
means no: the cost of being wrong that way is a skipped screenshot, and the cost
the other way is the user's page disappearing mid-sentence.

**Scrolling means scrolling what is being read, which is the dialog.** An
observation describes the topmost dialog, so `SCROLL:` and the `scroll` action
have to be measured on and applied to *that*, via `scrollableIn(dialog)` —
largest scrollable descendant, not the first, since dialogs nest two or three
overflow containers and the innermost is often a 40px clipping strip. Measured
on Naukri's apply dialog: the recruiter's question sat below the fold of the
pane, `window.scrollY` against a one-screenful confirmation page behind it
rendered `SCROLL: 0% (at end)`, and the run finished saying there were no
questions to answer with the question visible on screen. Nothing catches this
by itself — the action returns `ok`, the page behind genuinely does move, and
the next observation is byte-identical, which the model reads as "nothing more
here". A dialog with no scroller returns an *error* saying so rather than
scrolling the document underneath it.

**One route attaches the file, and a late card is not a failed one.** A route is
abandoned on a timer, not on a refusal, so an app that draws its attachment card
just past `PROBE_MS` is indistinguishable from one that ignored the file — and
the only difference is that firing the next route uploads it twice. So
`landed()` counts cards against a baseline taken before the *first* route and is
checked before each route as well as during, and there is one last wait after
all four rather than a "not delivered" notice for a file the app is holding.
Two things fed the original bug and both had to go: `composerZone` stopped at
the first element naming itself `composer`, but ChatGPT draws the card tray as
that surface's *sibling*, so no test could see the file arrive; and
`nameWasShowing` was computed against the whole document, where the previous
turn's copy of the same CV is already on screen, which killed the one test a PDF
card reliably answers. `drop` also has to end the drag — a bare
`dragenter`/`dragover`/`drop` leaves ChatGPT's full-window "Add anything"
curtain up over the composer and send button for the rest of the turn.

**An extension cannot draw in the tab strip.** Chrome's blue rule under a
captured or debugged tab is Chrome's, and there is no API to ask for it. The
`.topline` in `agent-page.js` is the nearest thing: a 3px fixed line at the top
of the page, the same signal one toolbar lower, and `position: fixed` so it does
not shift the page's layout by a pixel. The favicon dot is the only mark that
reaches the strip itself, which is what makes a background tab the agent opened
identifiable while you are looking at a different one. It keeps the original
`href`s rather than reconstructing them — plenty of sites swap their own favicon
for unread counts, and putting back a guess leaves the page permanently wrong in
a way nobody would connect to us. A cross-origin icon taints the canvas and
`toDataURL` throws; that is caught and ignored, because the dot is a nicety and
the line is the indicator that has to work.

**A greeting is not a task, and a run started on one never ends.** "hyy", typed
with Agent Mode still lit from the previous question, opened a start page, took
a screenshot of it, and searched Google for "hyy" — because a model handed a
browser and told to act will act, and the vocabulary has no way to say "there is
nothing here to do". Nothing can ever count as finishing, so it runs to
`MAX_STEPS` with a curtain over the page.

`isNotATask` in `run.js` is the guard, and three things about it are
deliberate. It is checked BEFORE `resolveAgentTab`, which navigates a tab and
waits up to five seconds for it to settle — the point is that the user's browser
is not touched at all. It ANSWERS rather than refusing: a red error over a
greeting reads as a fault in the extension, and what the person actually needs is
the sentence saying what to type instead. And it matches the WHOLE input rather
than searching inside it, because "hi, open my gmail" is a real task with a
greeting on the front. One short token, nothing with a space in it.

The character classes rather than a word list are the other half. What people
type is "hyy", "hii", "heyyy", "helloo", "okkk" — a fixed list of correctly
spelled greetings catches none of them, which is how this reached the browser in
the first place.

**A resumed thread has to be told the old task is over at the END of the
message, not only the top.** `NEW_TASK_BANNER` exists and is correct, and it is
the first thing in the first prompt — with the entire element list and up to 45k
characters of page between it and the end. What the model acts on is what it
read last. Measured: a chat whose previous run had read Gmail, given an
unrelated task, came back *"The navigation to Gmail failed with a 301 redirect,
likely due to browser fingerprinting… I will attempt to observe the current
state"* — several steps into a run that had nothing to do with Gmail, with the
panel showing the new task throughout. From outside, the run simply did
something nobody had asked for.

So `run.js` passes `resumed: sameSession` into the loop and `closing()` restates
it, placed after `THE USER'S TASK` and before the format demand: it is about
WHICH task, so it belongs beside the task, and the last thing read must still be
the shape of the reply. Same division of labour as every other rule here that
appears in two places — this is not belt and braces, it is the half that lands.

`disownOldTask` is its own flag rather than `resumed && step === 0`, and that is
not style: `step` is declared below the first `message`, so reading it from
`tail()` is a temporal dead zone error — one that fires ONLY when `resumed` is
true, because the `&&` short circuits otherwise. It survives a misread re-ask on
purpose (a model answering about the old task is exactly the case being
corrected) and clears the moment a reply carries an action, because from then on
the thread's most recent history is this run's own.

**Every AGENT_ERROR needs an AGENT_FINISHED.** Only `AGENT_FINISHED` releases the
composer. A preflight refusal that sends the error alone freezes the panel until
reload. `agent/run.js` has a `refuse()` helper for exactly this.

**A stall is recovered from, not reported.** "Timed out before the provider
produced a reply we could match to this question" and its siblings name a cause
the reader can rarely act on — the tab is signed in, the selectors are usually
fine, the hidden page has simply wedged — and the fix is mechanical: close the
window, open a fresh one, ask again. `ask-provider.js` does that up to
`MAX_ATTEMPTS` times and swallows the failed attempt's `error` event, because
the panel renders an error and never un-renders it, so leaving it in place puts
a red "it timed out" above the answer that arrived a minute later. Three things
hang off that and none is optional: `recover.js` closes the **whole relay only
when nothing else is in flight** — compare mode has three answers sharing that
window, and tearing it down would kill the two that are working, each of which
would then recover by closing the window the others had just reopened; the gap
between attempts keeps a `recovering` placeholder in `inflight`, or Stop finds
no entry, cancels nothing, tells the panel nothing and the retry proceeds
anyway; and `deep-ask.js` no longer retries a reading turn itself, since retry
on retry makes one dropped part cost six full response timeouts.

**MV3 kills the worker after ~30s idle.** Anything that waits on a message
rather than an API call must hold the keep-alive: `holdKeepAlive()` /
`releaseKeepAlive()` in `transport/inflight.js`.

**The provider page is hidden, and Chrome economises on hidden pages.** This is
the single biggest source of "it only replies when I look at it". Measured on a
chained 200ms poll in a minimized window: 200ms visible, **1000ms hidden**. Four
layers fight it, and they are not interchangeable —

| layer | where | measured effect |
|---|---|---|
| worker-driven ticks | `transport/inflight.js` | our own waits: 11.2s → 3.1s |
| `autoDiscardable:false` | `transport/keep-awake.js` | tab is not discarded |
| Web Lock | `adapters/adapter.js` | freezing exemption |
| visibility spoof (MAIN world) | `transport/keep-awake.js` | `hidden:false`, `hasFocus:true` |
| **debugger pin** | `transport/keep-awake.js` | **poll median 1002ms → 202ms** |

The debugger pin (`Emulation.setFocusEmulationEnabled` +
`Page.setWebLifecycleState:'active'`) is the only one that actually lifts the
clamp; everything else is defence in depth. It costs an infobar on a tab inside
the hidden relay window, so nobody sees it. `tabWakePolicy` in
`providers/config.js` steps it down to `'soft'` or `'off'`.

The spoof changes what the *site* believes, not what Chrome does — it does not
affect throttling, and it cannot swallow a `blur` listener the site registered
before we injected. Do not treat it as the fix.

Every layer is reversible and torn down in `releaseTab()` / `releaseAllTabs()`.
An orphaned `chrome.debugger` attachment leaves the infobar behind, so release
before closing the relay.

Do not add a wait in the adapter that cannot be woken by `wakeWaiters()`.

**Do not leave a fast `setInterval` running in the worker.** It resets the idle
timer, so the worker never sleeps. The heartbeat stops itself the moment nothing
is in flight.

**A right-click opens the panel before it does anything else.**
`chrome.sidePanel.open()` needs a user gesture, and a context-menu click only
counts as one *until the first await* — so the open call in `context/handoff.js`
comes before every check, and the relay guard comes after it. Opening the panel
over a provider window is harmless; handing it that window's text is not. The
handoff itself is parked in `chrome.storage.session` rather than posted, because
`open()` returns long before the panel has booted, let alone connected its port
— the panel collects it at INIT. It is *also* pushed live when a port already
exists, since opening an open panel does not re-run boot and waiting for a
second INIT would hang. Highlighted text takes the same road and needs
`whenRelayReady()` for the same reason the pickers do: `page-context.js` runs in
provider tabs too, and before the ids are back one of those looks exactly like
the page you were reading.

**A file goes to the provider's uploader; text goes in the prompt.** "Add
files" takes both, and `attachments.js` sorts them by extension: a `.md` or a
`.csv` is read in the panel and travels inside the prompt as it always did, while
a PDF, a Word document or an image is turned into a data URL and pasted into the
provider's own composer by `adapter.js` — the same path the screenshot already
used, generalised from "an image" to `{dataUrl, name, type}`. Shipping a PDF
parser per format to do it ourselves would be worse than what the provider does
with the file natively, and a résumé is the case that made this necessary. Two
consequences: there is exactly **one** attachment slot (a provider composer
takes one, so an upload replaces a dragged crop and says so), and the prompt has
to *name* the uploaded file — the model is reading text that cannot contain it,
and without `<uploaded_file>` "does my CV match this job" gets answered from the
page alone with the attachment quietly ignored.

**Pasting the file is one of four routes, and the failure is silent.** A
synthetic `ClipboardEvent` is what every app takes for a screenshot, and it is
*not* what ChatGPT takes for a PDF — the file never arrived, the prompt still
named it, and the reply was a polite "please upload the PDF" with nothing
anywhere saying why. That asymmetry is why it went unnoticed for so long: the
image path worked, the document path did not, and the old code returned `true`
either way. So `attachFile` tries paste, then a drop, then any
`input[type=file]` already in the page (skipping one whose `accept` excludes
this file — setting `files` on an image-only picker uploads nothing and looks
exactly like success), then **opens the provider's own "+" menu** and uses the
input that appears: ChatGPT builds no file input until that menu has existed
once. Only the menu button is clicked, never the item inside it, which opens
the OS file dialog and would park the run behind a window nobody can see.

Each route is *verified* before the prompt is typed, and the checks are as
loose as the markup demands: a recognisable preview, or **the filename showing
up somewhere it was not before**. A PDF renders as a card whose only dependable
feature is its name, and the before-shot is what stops the previous turn's copy
of the same CV reporting success for this one. Do not scope that to
`closest('form')` — ChatGPT's composer is a ProseMirror contenteditable in
plain divs with no form anywhere, which is what `composerZone` climbs for. If a
route cannot be confirmed but the composer *changed shape* while we watched, it
counts: the app took the file and drew something we do not recognise, and
trying the next route as well is how one CV becomes two attachments.

`attachFile` returns whether it worked. `run()` puts that on the `submitted`
event as `attached` (absent when the turn carried no file, so an agent run's
later turns cannot answer for the one that had the CV) plus a `notice`
sentence, and the panel marks the chip on your message `attached` or `not
delivered` and prints the sentence under the answer. An answer written without
the CV must not look like one written with it. The bytes are decoded with
`atob`, not `fetch(dataUrl)`: a content-script fetch is one more thing that can
fail on a strict site, and its only symptom is an attachment that never
appears.

**The prompt names the file, so "is the name on screen?" answers yes before we
attach anything.** The filename is the *only* dependable evidence a PDF landed —
its card has no `blob:` preview and half the apps never write "attachment" in
any class — and that test was a boolean compared against a before-shot:
`nameWasShowing` at the top, `!nameWasShowing && nameShowing()` in `landed()`.
The before-shot is right and the boolean is not, because `<uploaded_file>` in
`context/prompt.js` *puts the filename in the prompt* — without it the model
answers from the page and ignores the attachment. So the moment one turn has
gone out, the thread above the composer says the filename forever, the test is
switched off for the rest of that conversation, and the file has to be
recognised by markup alone. Measured on a Gemini-shaped fixture with the tray
drawn outside the composer subtree: one card in the page, `attached: false`, and
“… could not be handed to Gemini — the answer below was written without it.”
over an answer written *from* the CV. Counting occurrences fixes it without
giving up the before-shot: a new card adds one whatever else is on screen. Two
supports under it, both cheap and neither sufficient alone — `composerZone`
keeps climbing until the uploader's own button is inside it (the button, never
`input[type=file]`, which several providers declare as `attach` and which often
sits at the end of `<body>`: climbing to reach *that* makes the zone the page,
`shape()` then differs after any route at all, and route one always looks
confirmed so the route that actually works never runs), and `CARD` also matches
the file-preview names. What is deliberately NOT bought: an app that draws its
card more than `PROBE_MS` after accepting a paste still gets the next route
fired at it and still ends up with two copies. `landed()` is sampled the instant
the probe expires, and a grace before each remaining route would put ~1.8s on
every attachment that genuinely fails.

**`preventDefault` is the app saying "I took that", and it is the difference
between one upload and two.** A route is abandoned on a timer, so an app slower
than `PROBE_MS` to draw its card is indistinguishable from one that ignored the
file — and the next route then hands it a second copy, which arrives *after* the
turn has gone. What that looks like from the outside is the bug it was reported
as: the message sends, and a leftover thumbnail is still sitting in the composer
underneath it, "as if it typed the text and attached the picture afterwards".
Cancellation is the signal that was already there and unread. A page accepts a
drop by calling `preventDefault` — the spec gives it no other way — and an
editor that renders its own paste does the same. So a dispatched event that came
back cancelled gets `CONSUMED_PROBE_MS` to produce a card instead of a sibling
route. The reverse does NOT hold and was tried: shortening the probe for an
UNcancelled event, on the reasoning that an app which did not cancel had ignored
us, fires the next route into an uploader that accepted the paste and simply
draws its card a beat later. The costs are not symmetrical — being early loses
the user's attachment, being late costs two seconds — so an uncancelled event
keeps the full `PROBE_MS`, as do the input routes, which cancel nothing. Two
things it must NOT do. It must never resolve `attached`: Quill cancels every
paste, files or no files, so cancellation is a hint about pacing and never
evidence of delivery. And it must not END the sequence — a route that stopped on `consumed`
would take the one provider whose working route is the drop and never fire it;
six seconds of no card and no change of shape is the app saying it did not take
the file, and a route it did not take cannot become a duplicate. Measured on the
Gemini-shaped fixture, `HEAD` → now: card at 600ms, 10.4s and a false notice →
**3.2s and delivered**; card drawn late, **two** cards and a false notice → one
card, 5.0s, delivered; a Quill-style editor that cancels the paste and only
takes the drop, false notice → delivered, 8.2s. The one case that got slower is
an app that cancels the paste and takes nothing at all: 10.3s → 11.2s, and it
ends in an honest "not delivered" either way.

**Escape closes the attach menu, and it also cancels an upload.** It is the only
way we have to put away a menu we did not build, and the menu covers the send
button — a run that cannot click send is worse than one missing an attachment.
But reaching `openAttachMenu` at all means the three routes before it were read
as failures, and the commonest way that happens is a card we did not recognise
rather than a file that never arrived. So the Escape landed on an attachment the
app WAS holding and removed it: the picture appears in the composer, vanishes a
second or two later, and the turn is then typed and sent without it. From the
panel every layer reports success. It is now skipped when `landed()` is true,
re-checked at that moment rather than trusting the check at the top of the loop,
because the two seconds spent waiting for the menu's own input is exactly the
window a late card lands in.

The deeper cause is that `zone` is a guess about where an app draws its tray, and
when the guess is wrong every test in `attachFile` answers "nothing happened"
about a file plainly sitting on screen. `previews()` is the cheap insurance: an
agent run's attachment is almost always an image, and an image preview is the one
thing every app renders identically — an `<img>` off a `blob:` or `data:` URL —
so it is counted document-wide against a baseline. Document-wide is safe ONLY
because of the timing: attaching happens before a character of the prompt is
typed, so nothing is streaming and the thread above is not gaining pictures on
its own. Measured on a fixture whose thumbnail names nothing matchable and which
cancels on Escape: `attached: false` with the picture destroyed and the turn sent
without it, in 10.3s → `attached: true`, thumbnail kept, one route fired, 2.2s.

**The reply poll runs several times a second, so what it does per pass is a
budget.** It is not on a 250ms timer in practice: `sleep` returns early on any
DOM mutation — that is how the hidden-window clamp is beaten — and a streaming
reply mutates continuously, so the loop turns over at the 80ms floor for the
whole of every answer. Two things it did on every one of those passes are now
memoised, both on signals that need no layout. `findOurMessage` walked EVERY
user message in the thread converting each to markdown, against a conversation
that only grows — so it is cached on the user-message count, which is the one
thing that can change the answer (not on time, and never on the first match:
every agent prompt in a run opens with the same eighty characters, so a cache
that held the first hit would pin the anchor to the previous turn and attribute
the last answer to this question). And the reply node is re-converted only when
`textContent.length` or the descendant count moves — the second half matters
because a code block closing changes markup without changing text, and
`openFence` reads that markdown to decide whether the reply is finished.

Raising the 80ms floor is the obvious next move and was tried and reverted:
measured on a twelve-turn thread it cost ~100ms per turn (5.70s → 5.81s) and
bought nothing measurable — median and p95 frame gaps identical to the digit.
Note also what that same fixture did NOT reproduce: a provider tab going
unresponsive to the user. Frame gaps stayed at 6.9ms median with zero janky
frames on both the old and new code, so the reported freeze is not this loop,
and the memoisation above is a reduction in waste rather than a fix for it.

**The debugger pin is attached for the life of the tab, and the user can now
step it down.** `releaseTab` is only reached from `recover.js`, so the pin goes
on with the first question and stays until the tab closes — which is what the
"started debugging this browser" bar is. That is the most invasive thing done
to a page anywhere in this extension and it had no control anywhere in the UI,
so the only way to test whether it is behind odd behaviour in that window was to
edit `providers/config.js`. `tabWakePolicy` is now on the options page, and
`keepTabAwake` DETACHES an existing pin when the policy no longer allows it —
an early return on the new policy would leave the debugger attached until the
browser closed, and a setting that only affects the next tab reads as a setting
that does nothing.

**The provider window opens while the page is still being read.** Everything up
to `ready` — creating the relay window, loading the app, arming the anti-throttle
layers, injecting the adapter — is "opening the provider", and on a cold start it
is most of the wait before a single character is typed. It also has nothing to do
with the prompt, and both callers spend seconds building one: an agent run reads
the page, scrolls it for a deep observation, and stitches a survey picture a
screenful at a time; a chat with context on scrolls the user's tab to the bottom
and back. All of that used to happen with the provider window still shut, after
which the run paid for opening it as well. `warmProvider` in
`transport/ask-provider.js` does the same work and is started in parallel and
never awaited. What makes that safe rather than a second window is that
`ensureProviderTab` is single-flighted per provider — the real `attemptAsk`
either joins the warm-up's promise or finds the tab already open. It is
best-effort and swallows everything: the ask does all of it again and reports
properly when it fails, and a warm-up must not be able to fail a run that would
otherwise have worked. `fresh` deliberately does NOT pre-navigate to the new-chat
URL, because `resetProviderTab` does that at ask time and doing it twice loads
the app twice; what is worth pre-paying is the window and the first load. For the
same reason the adapter is only injected when the ask will not be navigating away
from it.

**An attached file lands inside the sent bubble, and it moved the anchor.**
`findOurMessage` matches the first `FINGERPRINT_CHARS` of what we typed against
the rendered user message — and a file renders *within* that message, above the
text, so the node now begins with the filename and the prompt starts a line
later. `startsWith` therefore failed on exactly one turn: the one carrying the
CV. No anchor means `freshText` returns nothing, nothing can be attributed to
the question, and a reply visibly sitting in the relay window times out after
five minutes, recovers, and asks again — three times. Measured on a fixture at
a 20s timeout: `startsWith` → "Timed out before the provider produced a reply
we could match to this question" with the answer in the DOM the whole time;
`includes` → the reply, in ten seconds. There is a second fallback under it: if
nothing matches but a user message exists that was *not there before we typed*,
that is ours. More than one provider collapses a long message behind "Show
more" by truncating the DOM rather than the display, and every one of those
turns is otherwise a five-minute timeout.

**The agent carries the attachment too, on the first turn with a free slot.**
"Fill this application in from my CV" is the whole point of attaching one, and
it used to go nowhere — `AGENT_RUN` carried no file, so the run ended with "I
did not invent your details" about details it had been handed. `runAgent` takes
`upload` and `claimUpload()` spends it on the first message that is not already
carrying a screenshot, because a provider composer takes one attachment and a
photo of a page the DOM cannot describe is the more urgent of the two. It is
claimed *while the message is being built*, before `renderObservation`, so that
`image: Boolean(pendingImage)` keeps meaning "a screenshot" — tell a turn to
look at a picture that is actually a PDF and it looks at neither. Sent once:
the provider thread keeps it, and re-uploading a CV per step would cost an
upload per click.

**A sent message lists everything that went with it, and they are not one
list.** Text files are inlined in the prompt and therefore always arrive;
an upload is handed to the provider's own uploader and might not. Showing only
the second made a question sent with a CV and two files look like a question
sent with a CV. So `attachmentChips()` renders one chip per file with the state
that belongs to it — `in the prompt` for the inlined ones, `attaching…` →
`attached` / `not delivered` for the upload. The composer's own row of cards is
gone the moment you send, and afterwards nothing else on screen can answer "did
my CV actually go with that question".

**The panel takes a dropped file and a pasted picture.** Both gestures were
dead: Chrome's default for a file dropped on a page is to *navigate to it*, so
a dragged CV replaced the panel with `file:///…` and took the conversation with
it, and Ctrl+V of a screenshot did nothing because a clipboard image never
touches `input.value`. `bindDropAndPaste` in `app/events.js` binds the document,
not the composer — the target people aim at is "the panel", and a 40px textarea
is hard to hit while dragging — and counts `dragenter`/`dragleave` depth,
because those fire per element crossed and watching `dragleave` alone flickers
the overlay on every inner border. The overlay is `body::after` for the same
reason: a real element appearing under the pointer mid-drag fires `dragleave`
on what it covers. Paste never calls `preventDefault` on text the composer or a
sheet field is already going to receive, or pasting a paragraph into the box
this panel exists for stops working. And the sort by extension gets a MIME
fallback: a clipboard image is a `File` with no name at all, so a name-only test
sends a PNG down the text road and `file.text()` attaches a page of replacement
characters.

**A paste lands where the FOCUS is, and the panel was claiming a focus it did
not have.** Two halves of one report — "when I paste it goes into Google, not
into the sider" — with the pasted text sitting in the address bar and the
composer glowing beside it, three attempts deep.

The paste listener was on the textarea, so it only ever fired for a paste aimed
at the textarea. A click on the thread, on a button, or on one of the
empty-state cards leaves `document.body` holding the focus, and Chrome
dispatches the paste THERE — no listener, no default action worth anything, and
Ctrl+V does nothing at all. Nothing on screen says why, so the reasonable next
move is to try it somewhere that does work, which is the omnibox. It is now
bound on the document like the drop, for the same reason the drop is: what
people aim at is "the panel". A field that owns its paste keeps it — a sheet
filter, the skill editor's prompt — and the composer keeps its text and gives up
only its files, which is exactly the old behaviour. Everything else goes in the
composer through `insertIntoComposer`, which uses `execCommand('insertText')`
rather than assigning `value`: that keeps the undo stack, respects a selection,
and fires `input` itself, which is where autosize, `syncTokens`, the ink layer
and the '@'/'/' menus already live. Rebuilding that list at a second call site
is how the two ends drift, and the drift is silent — a badge painted for a token
`state` no longer holds.

The other half is that `:focus` OUTLIVES the window losing focus, and `boot()`
focuses the composer the instant the panel opens. So a panel nobody has clicked
draws a lit, ready-looking box while every keystroke goes to whatever the
BROWSER has focus on — and opening the panel from the toolbar leaves that on the
omnibox. The ring was not a symptom of the bug, it was most of the reason the
bug is unreadable: it says "type here" while the keyboard is somewhere else.
Nothing in JS can take focus back from the omnibox, and that limit is real — one
click on the panel is still required. What `bindPanelFocus` can do is stop
lying: `body.unfocused` gates the glow in `composer.css`, and on regaining focus
the caret returns to the composer *only* when nothing inside the panel has taken
it. Anything that has — a sheet field, the skill editor — is left alone, because
this fires on the way back from an alt-tab too, and a caret that jumps out of
the form you were filling in is worse than the ring ever was.

**Pointing at the page has two answers, and they are not interchangeable.**
`PICK_ELEMENT` sends what an element *says*; `PICK_REGION` sends what a region
*looks like*. A chart, a diagram, an embedded screenshot and a layout that has
gone wrong have no text worth extracting, and asking about them from the DOM
produces a confident answer about markup nobody was looking at — which is why
the "+" sheet asks which one you meant rather than guessing. The rectangle comes
back in CSS pixels because that is what `captureVisibleTab` photographs, and the
crop happens in the worker with `OffscreenCanvas` (there is no DOM there, and an
offscreen document for one crop costs more than the capture). Multiply by the
page's `devicePixelRatio` or every crop on a HiDPI screen is the top-left quarter
of what was selected.

**The curtain blocks scrolling too, and it must never block its own exit.**
Two failures, one listener. Blocking clicks alone left the page scrollable, and
a page that scrolls under the agent is the same bug the curtain was written for
— the model picked an element at one scroll position and clicks it at another.
`wheel` and `touchmove` have to be registered `{passive: false}` or
`preventDefault` is ignored, because Chrome makes them passive by default on
`window`: the listener ran, returned, and did nothing at all. Meanwhile
`blockTrusted` sits on `window` with capture, so it ran *before* the "Take over"
button inside the overlay and `stopImmediatePropagation` killed the one click
that exists to let the user out — a curtain with a decorative exit is worse than
one with no exit, because the user presses it and concludes the extension has
hung. The exemption is the **pill**, found through `composedPath` (from outside,
`event.target` is only ever the shadow host), and it must not be the whole
overlay: the curtain is in the overlay too and covers the window, so exempting
that would let everything through, including the wheel events it exists to
swallow.

**While the agent drives a page, the user does not.** The curtain in
`content/agent-page.js` takes the clicks: two clicks landing on one page from
two directions is not a race the user can win, because the model chose what to
click from an observation taken *before* their click changed the page, so it
acts on a page that no longer exists and the run reports something that never
happened. The blocker only stops `isTrusted` events — the agent's own
`el.click()` and its synthetic Enter are untrusted and pass straight through, so
do not "simplify" that check away or form submission dies. It is a curtain and
not a lock: `Take over` releases it on the spot, because trapping someone in a
page until a background process finishes is worse than any mis-click.
`takeControl` is per tab and remembered in `agent/page.js`; the release lives in
the one `finally` in `agent/run.js` that runs on every path out of a run —
finished, cancelled, thrown, or refused in preflight. A curtain left up is a
page nobody can click with nothing running to explain why.

**An empty code fence is not a code block.** A reply re-renders on every delta,
and the first delta of a fenced answer is the opening ``` alone — which drew a
full card, language label and Copy button around nothing, sometimes before the
provider had produced a character. `codeBlock()` returns '' for a blank body.
Same class of bug as the caret: it goes *inside* the last block (and inside the
`code` of a card), or it renders on a line of its own under the text it is
supposedly writing.

**Declare `color-scheme`, or Chrome draws light widgets on a dark panel.** A
`<select>`'s open list is drawn by the OS and takes its colours from that
property alone — no rule on `option` reaches it on Windows. Both `tokens.css`
and `options.css` declare `light dark`; it also covers native focus rings, the
caret and any scrollbar the custom rules miss.

**The agent's on-page overlay is drawn after the camera, never before.** The
ring, the ripple and the "Agent clicked" tag in `content/agent-page.js` exist
because a page that rearranges itself with no cursor moving is indistinguishable
from a page misbehaving. Three things keep them from becoming part of the page:
a shadow root (the site's CSS cannot restyle them and ours cannot leak),
`pointer-events: none` (it must never eat the next real click), and removal on a
timer rather than on a page event. The screenshot flash is sent by **`captureTab`
itself**, after the veil goes back up — fire it before and the model is looking
at our overlay instead of the page. It lives there rather than at the call site
because most of a run's pictures are the loop's own idea (a step that failed, a
page that is all pixels, a form that keeps refusing), and while only the
explicit `screenshot` action announced itself the flash appeared for perhaps one
capture in five. From the user's side that reads as an animation that half
works, when in fact most screenshots were silent. `AGENT_SHOT` goes further and shows
the picture itself, bottom-right, for both paths — the region you dragged and the
screenshot the agent decided to take: "a screenshot was taken" and "*this* was
sent" are different amounts of information, and only the second can be checked.
It rides in the same overlay root, so the veil that hides the curtain during a
capture hides it too — otherwise the last shot ends up inside the next one. All of it is off when
`agentHighlight` is off, which the content script reads from storage itself and
keeps live through `onChanged`, rather than having the flag threaded through
four layers of the action path.

**The model can ask the user a question, and that is not the same as the
approval policy.** The policy gate asks "this looks risky, shall I?" — an
assessment the *extension* makes about an action it is about to run. Nothing let
the model ask anything, so "fill it in but check with me before submitting" had
exactly one move available: `finish` with a question in the answer. That reads
as a request and *is* the end of the run, so "yes" has nothing left to continue
— the user sees a polite "please confirm if you want me to submit" and no way
to say so. `ask` puts a real yes/no in front of them and the run carries on with
it, quoted back in the next RESULT alongside its question (a bare "the user
approved" is ambiguous in a run that asked two things, which is exactly when it
matters). Three things are load-bearing. It is **not gated on `policy`**:
"Never ask" means "do not stop me for your own risk assessments" and cannot mean
"ignore the instruction I just typed". It **ends the batch**, like `finish` —
everything queued after a question was planned without knowing the answer, and
`[ask "shall I submit?", click Submit]` submits either way, which is precisely
what the question existed to prevent. And the prompt has to say to use it
*instead of* finishing, next to `finish` itself, because that is the action it
gets confused with.

**A provider holds two threads, and a run starts a new one per panel chat.** A chat is
*meant* to accumulate — that is what makes the next question answerable — and an
agent run is the exact opposite: it has to start from the page in front of it.
One stored conversation per provider meant every run opened where the last one
had finished, and a model shown its own closing paragraph above a fresh task
repeats it rather than acting. Nothing about that failure looks like a transport
bug from the panel: no action parses, `MAX_MISREADS` ends the run, and what you
get is **"Agent finished · 0 steps"** with a fluent answer about a page the run
never looked at. Measured: a task to fill a sample form answered three times
running with the previous run's "the submission has reached a security
verification step", while the observed page was Google. `state/conversations.js`
is therefore keyed on a `scope` — `conversationUrls` for chat,
`agentConversationUrls` for runs — and `run.js` asks for `scope: 'agent'` with
`fresh: stepId === 1 && !sameSession`.

That `sameSession` half is the correction to a rule that was originally "a new
thread *every* run", which overshot. It fixed the failure above and created its
mirror: the run after it started from nothing, so "now publish it" reached a
model with no idea what "it" was, and the provider accumulated a sidebar of
one-task threads with the context split across all of them. Keying the thread on
the panel session id (`AGENT_RUN` carries `sessionId`; `run.js` keeps the owning
session in **`chrome.storage.session`**) keeps both halves: a follow-up sees what
the last task did, while New chat and a different tab still open clean.

**One slot per provider is not enough — it has to be one per provider PER
CHAT.** `conversationUrls` was `{providerId: url}` for the whole extension, and
`run.js` decided whether to resume it by comparing the panel chat against a
single remembered owner id. That is correct for exactly one conversation. With
two in play every switch fails the comparison, opens a brand new provider thread
AND overwrites the slot the other chat was using — so going back to the first
opens a new thread as well. Alternating between two chats therefore produced a
new provider conversation *per task*, which from the outside is a Gemini sidebar
holding one entry for every question the user has ever asked. It became easy to
hit the moment the panel started following tabs, but the shape was always wrong:
"which thread is this chat in" is a question per chat and it was stored per
browser. The store is now `{v:2, order:[…], buckets:{[sessionId]:{providerId:
url}}}`, `hasConversation(provider, scope, sessionId)` replaces the owner id
entirely — no global left to get out of step, and it survives a worker restart
for free — and both scopes carry `sessionId` from the panel. The chat scope
needed it just as much: `SET_CONVERSATIONS` only fired when you opened something
from history, so switching tabs swapped the conversation on screen while the
provider stayed in the previous chat's thread, and the next question in an
apparently blank chat continued somebody else's. Two halves fix that and both
are needed: `onActiveTab` pushes `SET_CONVERSATIONS` with `navigate:false` — the
record only, since `ensureProviderTab` steers the tab at ask time anyway and
driving the provider window on every tab switch is motion for nothing — and

**`SET_CONVERSATIONS` has two meanings and conflating them destroys a live
thread.** Opening a session from history is a deliberate "point at these" and
REPLACES what is stored. A tab switch is only "this chat is the one on screen
now", and there the STORED record must win: it is filed from the adapter as each
reply lands, while the panel's copy is a backup that can be behind it or empty.
Empty is the case that broke, and it needed both mistakes at once — `run.js`
forwards only STREAM events to the panel, so a chat whose only activity was an
agent run had `session.conversationUrls === {}` while the worker had the thread
filed perfectly. Sending that `{}` on the next tab switch wiped the bucket the
run had just filled; the next ordinary question found no thread, went `fresh`,
and Gemini got a second conversation for the same chat — the exact duplicate the
whole per-chat keying exists to stop, reintroduced by the code meant to help it.
So the seed path merges with the store winning, and `run.js` now forwards
`CONVERSATION` too. Now that runs and questions share one thread, the panel has
to hear about both.

Back to the two halves:
`ASK` passes `fresh: !hasConversation(…)`, because `ensureProviderTab` with a
null resume URL does NOT steer the tab, it reuses it exactly as it stands. So
"this chat has no thread yet" and "carry on where the last chat left off" were
the same call, and the first question in a chat opened by a new browser tab
landed in the previous chat's conversation. The agent path always forced a reset
there; the chat path never did. `askDeep` takes both and may only be `fresh` on
part 1 — a deep read is several turns for one question, and a fresh flag on each
would give every part its own conversation and leave the answering turn with
none of the findings above it. Buckets are capped at 24 and evicted oldest-first,
because this is `storage.local` and it is shared. The flat old shape is adopted
as the shared bucket on read rather than dropped, or upgrading would silently
detach every thread already open.

**There is now ONE provider thread per chat, not one per chat per scope.** The
`agent` scope is gone. It existed for a measured failure — a run opening in the
thread where the LAST run ended gets answered from that history rather than from
the page, three runs in a row at zero steps — but that is handled where it
belongs, by `NEW_TASK_BANNER` in `run.js`, which is the same guard that already
let consecutive runs share a thread. Keeping the split as well bought nothing and
cost the thing people actually see: one panel conversation appearing twice in the
provider's own sidebar under two unrelated names. The banner is worded for both
kinds of history now, because what sits above a task may be an ordinary question
the user asked in the same chat — and a banner that only named earlier *tasks*
left that case unexplained, which is how a run ends with "Would you like me to
format your Key Projects next?" where an action should have been. The price is
written down in `conversations.js` and is real: an agent run's JSON turns now sit
above the user's next ordinary question. Reinstating an `agent` key there and
pointing `run.js` back at it is the whole change if that ever costs more than the
duplicate threads did.

That storage choice is the whole fix and a module-level variable is the trap it
replaced. Worker memory reads as the safer option — a thread we can no longer
vouch for is not worth resuming — but MV3 kills the worker after ~30s idle, and
the gap between two messages in a conversation is nearly always longer. The
owner was null again on every run, every run looked like a brand new chat, and
the provider grew one thread per question: precisely the symptom the session key
exists to prevent, with the mechanism intact and invisible. Session storage has
the lifetime this wants — past the worker, gone when the browser closes.

The other half of "one thread per chat" is that the conversation URL is
*storable at all*. `looksLikeConversation` ignores a leading `www.` when
comparing hosts, because several providers are declared with a `www.` home and
land on the bare name (or the reverse): a strict compare rejects the genuine
conversation URL, nothing is ever filed, and every turn resumes nothing. It
fails exactly like the bug above and is one layer further down — Perplexity and
Kimi both did this on arrival, and Meta always had it. The banner is the other half and is not optional — a resumed thread
shows the model a *finished* task above this one, and without being told so it
reads that as work in progress and carries on with the old task, which is the
same "0 steps" failure moved one layer along. Three further things are
load-bearing. `fresh` has to *navigate*:
`ensureProviderTab` with a null resume URL reuses the tab exactly as it stands,
which after any earlier question is still sitting in that conversation, so "do
not resume" and "carry on where you left off" are the same call — `fresh` goes
through `resetProviderTab` instead. Only the *first* turn is fresh, because the
loop's whole design is that the plan and the observations accumulate in one
conversation. And the scope rides on the `inflight` entry, because the URL is
filed by an adapter event rather than by the caller; with no entry left to ask it
is a chat, which is what the untracked case has always been. The split fixes the
leak in the other direction for free — forty turns of JSON actions no longer sit
above the user's next ordinary question.

**The page border has six designs and they are chosen from pictures, not
names.** It is the mark that is visible wherever you happen to be looking, so it
carries "this window is not yours right now" on its own — and the right amount
of movement is genuinely not the same for everyone: the ones that travel
(`liquid`, `beam`) are found by the eye immediately and are also the first thing
to look wrong in a screen recording, which is why `corners` exists. The default
is `aurora`, which is a *wash* rather than an outline: four coloured lights at
the corners with the middle masked out of them. A rule around the edge says
"there is a boundary here"; lighting the whole edge says "this surface is in a
different state", which is the thing actually being communicated. The mask is
not decoration — the centre of the page has to stay honest, because watching it
is the entire point — and the drift is a transform on an already-painted layer,
so it is compositor work rather than a full-viewport repaint every frame. `FRAMES` in
`agent-page.js` and the radios in `options.html` are two lists that cannot see
each other, and a card offering a design the content script does not know is a
setting that silently does nothing — the frame falls back and the option reads
as broken. Three things to keep. `liquid` rotates a conic gradient through a
registered `@property`; a plain custom property is a string to the animation
engine and jumps once at 50%, which reads as a flicker rather than a rotation —
and the registration is document-wide even from inside the shadow root, hence
the unshareable name. The reduced-motion block has to give every design a
*static form* rather than just stopping it: `pulse` is entirely its wave, and a
stopped wave sits at whatever opacity frame zero had, which is invisible. And a
change applies live to a running curtain, because the only way to judge a border
is with the agent driving, so one that took effect next run would be chosen
blind. The settings previews in `options.css` are a hand copy of those
declarations — nothing in an options page can reach a content script's shadow
root — so changing one means looking at the other.

**The plan is a document, and four leading spaces is a code block.** A route
written the natural way — `ROUTE:` with its steps hanging under it — is indented
markdown, so every line of it became its own grey code card; and a `<pre>` with
`overflow-x: auto` inside the timeline's `min-width: 0` column collapses to a
sliver and wraps a word at a time. The single most useful note in a run rendered
as a vertical ribbon of single words, which reads as a broken renderer rather
than as the format the model was handed. Both halves are fixed and both are
needed: `plan.js` asks for flat GitHub-flavoured markdown with the three
sections spelled out, and `flatten()` in `ui/agent.js` strips indentation before
the renderer sees it — for the runs where the model does not comply. `flatten`
must not reach inside a fenced block: a plan quoting a snippet means it.

**The pointer says something while it waits, and a question never says it the
same way twice.** The waits are most of a run, and a drifting pointer says
"still working" but nothing more. `## Notes` on the planning turn asks for up to
twenty one-line facts about the site — gathered *there* because that is the one
moment the whole page is already in front of the model, and a second round trip
for something nobody is blocked on is pure latency. They are last in the reply
on purpose: a truncated reply should lose the notes, not the route. When the run
stops for an approval, `askedOnPage` puts a different sentence up instead —
different because a fixed one is read once and skipped forever after, which is
how a prompt becomes furniture, and it re-rolls on a repeat. It says the
decision is theirs and points at the panel; it deliberately does NOT repeat the
question, which would invite answering it in a place that cannot take an answer.
The `finally` around the confirm is load-bearing: declined, cancelled or thrown
past, the bubble must come down, or the page claims a question is open forever.

**The pointer stays alive between actions, and only while a run holds the
page.** Most of a run is a provider round trip — ten to forty seconds in which
the curtain is up, no click works, and nothing on screen moves at all. A frozen
arrow through that is the single thing that makes a working run look hung, and
the honest response to a hung run is to stop one that was fine. So the pointer
drifts: mostly tiny movements with the occasional longer reposition, and the
next real action travels from wherever it ended up. What keeps it honest rather
than decorative is the gate — it runs only while `curtain` is up, re-checked on
every tick because a run can end between two of them, so nothing ever drifts on
a page the agent is not driving. Three details are the difference between "a
person is working here" and "something is twitching". The interval is sampled,
never fixed: an evenly-timed nudge is the one thing a hand never does, and a
metronome reads as a progress indicator. Small and large moves come from
different ranges — sampling one range for both gives a pointer that vibrates in
place. And a drift is slow (1150ms, ease-in-out) where a real move is a 220ms
expo-out snap; give both the same easing and every purposeful reach turns into
another wander. A real move also *stops* the drift outright and restarts it a
beat later rather than the two taking turns at the same transform, which looks
exactly like what it is — a fight over the cursor. `releaseControl` clears the
timer, and `prefers-reduced-motion` turns the whole thing off.

**Agent mode is never persisted.** It is off on every load, by design. An agent
that could start acting because yesterday's setting was remembered is not one
you can leave open. The *policy* is remembered; the mode is not.

## Comment style

Comments here explain **why**, not what — the trade-off, the failure that shaped
the code, the thing the next reader would otherwise undo. Match that. A file
header says what the file is for and how it relates to its neighbours. Do not
add comments that restate the line below them.

## Verifying a change

There is no test runner. What exists, and works:

- **Syntax and imports:** `node --check <file>` for parse errors. Imports and
  exports resolve or the panel silently fails to boot — check both entries.
- **The panel, for real:** ES modules are blocked on `file://`, so serve the repo
  over http and open `src/sidepanel/sidepanel.html` with a stubbed `chrome.*`.
  That boots the whole panel in ordinary Chrome, including headless.
- **The background graph:** import `service-worker.js` in Node with a stubbed
  `chrome.*` and assert the listeners register. Walks every background module.
- **The agent loop:** `runAgent()` takes `ask`, `emit`, `confirm` and `signal` as
  arguments precisely so it can be driven from a test with a fake `chrome.tabs`.
  Scripted replies in, emitted events out. `tests/agent/survey-turn.test.mjs`
  does exactly that for the merged survey turn — and note what makes a
  round-trip count meaningful: the fake model READS its prompt and does the same
  three units of work either way, so the number that differs is how many times
  the provider had to be reached. A positional script of replies compares
  nothing, because the old code simply did less work per trip.
- **The content scripts, for real:** they are classic scripts with no imports,
  so a plain HTML fixture can `<script src>` both of them after stubbing
  `chrome.runtime.onMessage.addListener` — then call `observe()` through the
  registered handler. Drive it in headless chromium over CDP (Node has a native
  `WebSocket`; a chromium binary is already under `ms-playwright/`). This is the
  only way to test the scrolling: a fake DOM has no layout, so it cannot
  reproduce a scroll clamp, which is where the bug actually was.
- **A CSS refactor:** apply the old and new stylesheets to the same DOM and diff
  `getComputedStyle` for every element. Zero diffs means zero visual change.
- **The direct engines:** they take a `fetch` and a `chrome.*` and nothing else,
  so a fake `globalThis.fetch` returning a `ReadableStream` drives the whole
  path in Node — including the streaming, which is the half a recorded-body
  fixture cannot exercise. Split a fixture's chunks mid-line and mid-character
  on purpose; that is where `stream.js` earns its keep. `sentinel.js` is checked
  against the published SHA3-512 vectors, so a failure elsewhere is never the
  hash. `askDirect` is drivable the same way — pass it a `post` that collects,
  and assert the STREAM states, the thread filed after the turn, that a decline
  emits NOTHING at all, and that `cancelInflight` settles it as cancelled.

Do not claim something works because it parses.

## Loose ends

- `src/background/api.js` is a complete official-API transport that nothing
  imports. Either wire it up or delete it — do not half-use it.
- `src/adapters/adapter.js` is 840 lines and would benefit from a split, but it
  is a classic content script (see above), so it needs the manifest treatment
  rather than `import`.



need to reserch for usecases 
dashbord access
all of the dats should comes from suflum only we dont stoe any of the data in our db
## Browser fixtures

`tests/panel/*.html` are self-checking pages: serve the repo over http and open
one, and a box in the corner reports pass/fail. They exist because the failures
they cover are timing and layout, which a fake DOM cannot reproduce.

```
node -e "const h=require('http'),f=require('fs'),p=require('path'),t={'.html':'text/html','.js':'text/javascript','.css':'text/css'};h.createServer((q,s)=>{const x=p.join(process.cwd(),decodeURIComponent(q.url.split('?')[0]));f.readFile(x,(e,d)=>{if(e){s.writeHead(404);return s.end()}s.writeHead(200,{'content-type':t[p.extname(x)]||'text/plain'});s.end(d)})}).listen(8742)"
```

- `stop.html` — Stop keeps the composer locked until the worker confirms, and
  both escapes work. ~15s, because the grace timer is part of what is tested.
- `arena-send.html` — a chat UI with no streaming marker whose send button is
  also its stop button. Proves the next question does not kill the previous
  answer.
- `arena-reversed.html` — a `flex-col-reverse` thread. Add `?flat=1` to turn
  `reversedThread` off and watch it return the first reply in the conversation,
  which is the reported bug.
- `curtain.html` — the agent's click blocker survives `agentHighlight: false`.
- `paste.html` — where a paste lands. Proves a Ctrl+V that arrives with the body
  focused reaches the composer, that a paste aimed at the composer or at a sheet
  field is left alone, and that the composer stops glowing when the panel has no
  focus. A fake DOM has neither a focus model nor a default action to prevent.

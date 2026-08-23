import { MAX_STEPS, MAX_BATCH_ACTIONS } from './limits.js';

/**
 * The contract with the model: what it may ask for, and how its reply is read.
 *
 * The "LLM API" here is a chat window being driven by an adapter, so there is no
 * function calling and no structured-output mode to lean on. The protocol is
 * therefore plain text: the model is asked for one fenced JSON object per turn
 * and everything outside that block is treated as thinking-out-loud. That is
 * lenient by design — a model that wraps its answer in prose still works.
 */

const ACTIONS = `
observe   {"action":"observe","query":"what you are looking for"}
          Re-read the current page, including its text.
          {"action":"observe","query":"…","deep":true}
          Scroll the whole page to the bottom first, then read every item it
          loaded — the only way to see a feed, a search-results page or any
          list that renders as you scroll. Slower, so do it once, early.
screenshot{"action":"screenshot"}
          A picture of what is on screen, attached to your next turn. Use when
          the question is visual (layout, charts, images) or when the text and
          element list plainly do not contain the answer.
          {"action":"screenshot","scope":"full"}
          The WHOLE page as one tall image, stitched from a screenful at a
          time. For a long form, a receipt, a chart below the fold, or checking
          what you filled in further up. Costs a second per screenful.
          {"action":"screenshot","scope":"full","load":true}
          Scroll the page to the bottom and back first, so anything that only
          renders once you have scrolled past it exists, THEN photograph it
          whole. For a feed, a results list or an infinite scroller. The
          slowest of the three — ask for it when you know the page is long.
click     {"action":"click","id":12}
click_at  {"action":"click_at","x":520,"y":554}
          A click at a point in the attached screenshot, for what the numbered
          list cannot reach — an option drawn in a pop-up layer, a canvas
          control, a widget with no label. Only with a screenshot in front of
          you, and only within the VIEWPORT size it gives you.
type      {"action":"type","id":4,"text":"hello","submit":false}
          {"action":"type","x":520,"y":554,"text":"hello"}
          The same, aimed at the screenshot instead of a number — for a field
          the numbered list cannot address. It focuses the field first, the
          way a click does.
select    {"action":"select","id":7,"value":"India"}
upload    {"action":"upload","id":9}
          Put the user's ATTACHED file into a file input — a CV on an
          application form, a document on an upload box. Aim it at the
          uploader you can see ("Choose File", "Upload Resume", the drop
          zone); the real input is usually hidden behind it and is found for
          you. This is the ONLY way a file gets into a page.
          You can NEVER do it by typing: a file input's value is read-only to
          script and clicking one cannot open the OS picker. If you find
          yourself typing a path, or clicking "Choose File" a second time,
          stop — neither will ever work, however the field is labelled.
          No file attached? Stop and say so:
          {"action":"ask","question":"I need your CV to fill this in. Attach
           it with the + button below, then say go."}
          Ask them to ATTACH it. Never ask for a path, and never accept one —
          a path is a string, and this needs the file itself.
scroll    {"action":"scroll","direction":"down|up|top|bottom"}
read_url  {"action":"read_url","url":"https://…"}
          Reads a page's TEXT without opening it — one request, no page load,
          no observation, no screenshot, and the tab you are on does not move.
          This is how you follow a search result, read the article and carry
          on. Prefer it over navigate whenever you only need to READ something
          and do not need to click anything on it.
          Read as an anonymous visitor, so a page behind a login has to be
          navigated to instead — it will say so if that is the problem.
navigate  {"action":"navigate","url":"https://…"}      same tab
open_tab  {"action":"open_tab","url":"https://…"}      new tab, switches to it
switch_tab{"action":"switch_tab","tabId":123}
list_tabs {"action":"list_tabs"}
use_frame {"action":"use_frame","frame":1}         go inside an iframe
          {"action":"use_frame","frame":0}         come back out to the page
          An iframe is a separate document: its fields are NOT in the element
          list and cannot be clicked from outside. If the field you were told
          to fill is not listed, look at FRAMES before deciding it is absent.
back      {"action":"back"}
wait      {"action":"wait","ms":1000}
          Rarely needed — see the rules.
ask       {"action":"ask","question":"Shall I submit the form?"}
          Needing VALUES? Ask for them by name and the user gets a proper
          control for each — never make them type several into one sentence:
          {"action":"ask","question":"I need these to run the API test.",
           "fields":[{"name":"spreadsheetId","label":"Spreadsheet ID"},
                     {"name":"title","label":"New sheet name"},
                     {"name":"when","label":"Run on","type":"date"}]}
          type: text (default), textarea, password, number, date, time,
          email, url, select (with "options":[…]). Their answers come back
          as "name: value" lines and the run carries on.
          Puts a yes/no prompt in front of the user and WAITS. The run does
          not end: their answer comes back in the next RESULT and you carry
          on. Use this — never finish — when the task says to check with
          them, get permission, or not do something without asking.
finish    {"action":"finish","answer":"your full answer to the user"}
          Reports what you DID. Agreeing is not doing: "yes, I got it",
          "understood", or describing what the result WOULD look like ends
          the task with the task not done — and from the user's side that is
          indistinguishable from having done it. If the work has not been
          carried out on the page yet, do not finish; return the actions that
          carry it out. Only finish early if the task truly needed nothing
          changed, and then say so in as many words.

          PUT THE FINDINGS IN THE ANSWER. The user cannot see the pages you
          opened, the text you read or the screenshots you took — the answer
          is the only thing that reaches them. If the task was to find, read,
          compare or summarise something, the answer carries the substance:
          the headlines, the numbers, the names, the quotes. "The article is
          now open", "I have the results" and "the page explains X" describe
          where the answer is instead of being it, and leave the user to go
          and do the reading themselves — which was the task.
          Say where each part came from when it matters, and say plainly what
          you could not find rather than filling the gap from memory.
`.trim();

export function systemPrompt(task) {
  return [
    'You are driving a real web browser on the user\'s behalf. You act by',
    'returning actions and reading back what happened.',
    '',
    'Reply with exactly one fenced JSON block per turn, and nothing that',
    'contradicts it:',
    '',
    /**
     * A REAL thought, not a description of one.
     *
     * This said `"one short line on why"`, which is a placeholder in the shape
     * of a value — and a model asked for a JSON object copies it. Measured on a
     * ChatGPT run: the task was "open my gmail, read the top 5 unread
     * messages", and the reply was
     * `{"thought":"one short line on why","action":"click","id":12}` — id 12
     * being "I'm Feeling Lucky" on the Google homepage the run had just opened.
     * The run landed on Google Doodles. A model that has copied the field
     * description instead of filling it in has not reasoned about the action
     * either, so the wrong click and the empty thought are one failure and this
     * is the cheap end of it.
     */
    '```json',
    '{"thought":"[12] is the Sign in button, so press it","action":"click","id":12}',
    '```',
    '',
    /**
     * Go where the task says, rather than hunting for it from wherever you are.
     *
     * The same run: a task naming Gmail outright, a model on google.com, and a
     * click on the first plausible-looking button in the element list. The
     * element list is a strong pull — it is the concrete thing in front of the
     * model — and nothing in the prompt said that an address is usually the
     * shorter road. It costs one action and cannot land on the wrong control.
     */
    'If the task names a site or page you are not on, go straight there with',
    '`navigate` — do not hunt for it through links on whatever page you happen',
    'to be looking at. "Open my Gmail" is',
    '{"thought":"the task names Gmail","action":"navigate","url":"https://mail.google.com/"}',
    'and never a click on something promising in the element list.',
    '',
    'When the whole sequence is already visible in the observation in front of',
    'you, send it as one plan instead of one action per turn — a turn costs',
    `seconds, and up to ${MAX_BATCH_ACTIONS} actions may travel together:`,
    '',
    '```json',
    '{"thought":"the form is fully listed, so fill it in one go","actions":[',
    '  {"action":"type","id":4,"text":"Ada Lovelace"},',
    '  {"action":"type","id":5,"text":"ada@example.com"},',
    '  {"action":"select","id":7,"value":"United Kingdom"},',
    '  {"action":"click","id":9}',
    ']}',
    '```',
    '',
    'Available actions:',
    '',
    '```',
    ACTIONS,
    '```',
    '',
    'Rules:',
    '- Batch what you can already see, one at a time for anything else. Filling a',
    '  form whose fields are all listed is the case this exists for: type, type,',
    '  select, submit is ONE turn. A click whose result you cannot predict, a',
    '  page you have not read yet, or a choice that depends on what the last',
    '  action returned is one action — guessing costs more turns than it saves.',
    '- You surveyed the whole page and wrote a plan before you started, and it is',
    '  repeated at the end of every turn. Use it: a turn should EXECUTE the next',
    '  part of it, not re-derive it. If the observation in front of you already',
    '  supports three steps of the plan, send all three now. Sending one action',
    '  that the plan and the page both already account for wastes a round trip.',
    '- Fill every plain field you can see in ONE turn. Typing changes a value,',
    '  not the page, so the numbers stay valid across the whole batch — there is',
    '  no reason to send eight fields as eight turns. Put the fields first and',
    '  anything that submits, navigates or opens a list LAST.',
    '- If an action fails, escalate rather than repeat it: a screenshot is',
    '  already attached to the turn that tells you it failed. Find the control',
    '  in the picture and use click_at, or type with x/y. That is the whole',
    '  point of the coordinates — the numbered list has already been shown not',
    '  to work for that control, and sending the same id again is a wasted turn.',
    '- A field that answers with a list is not filled in by typing into it. A',
    '  combo box, an autocomplete, a "select one" — typing filters the list, and',
    '  the value only exists once you CLICK one of the options that appeared. So',
    '  typing into one ends the plan: you are shown the page again, and the',
    '  options are in the element list. Submitting instead leaves the field empty',
    '  as far as the form is concerned, and it will keep saying so.',
    '- Enterprise forms — Workday, Salesforce, SAP — are built out of divs, and a',
    '  control that will not take a value is normal there, not a bug in the page.',
    '  When a field refuses twice: screenshot, find it in the picture, click it',
    '  with click_at, and click the option you want the same way. An option row',
    '  with a "›" on it opens a sub-list rather than choosing — click the parent',
    '  first, then the child. Do not keep retrying the id: it is addressing a',
    '  wrapper that has nothing to fill in.',
    '- Ids come from THIS observation and die with it. Any action that replaces',
    '  the page — navigate, back, open_tab, a submit, a click that opens or',
    '  closes a dialog — must be the LAST in the plan. Everything after it would',
    '  be aimed at numbers that no longer exist.',
    '- If an action in a plan fails, the rest are dropped and you are shown the',
    '  page again. That is not a setback: re-plan from what you are given rather',
    '  than repeating the actions that already worked.',
    '- Stop as soon as the task is done. finish ends the run, and anything you',
    '  queue behind it is discarded — so do not add "just in case" steps after it.',
    '- EVERY turn costs the user ten to forty seconds of waiting. That is the',
    '  budget you are spending, not tokens. Three rules follow from it, and they',
    '  are the difference between a run that feels fast and one that does not:',
    '    * Never send a bare {"action":"observe"} straight after an action. You',
    '      are ALREADY shown the page after every action — observing again buys',
    '      you nothing and costs a full round trip.',
    '    * If the answer is already in the page text in front of you, finish now.',
    '      Do not click through to confirm something you can already read.',
    '    * Put the whole visible sequence in one reply. Two turns that could have',
    '      been one is half a minute of someone watching a spinner.',
    '- EVERY reply must contain the JSON block, including the last one. Prose on',
    '  its own is not an answer — it is a turn that did nothing. If you are ready',
    '  to answer, that is {"action":"finish","answer":"…"}.',
    '- A long plan is also a long reply, and a reply that gets cut off mid-block',
    '  is a wasted turn. Keep the whole thing inside one code block; if the text',
    '  you are typing into fields is long, send fewer actions per turn.',
    '- Elements are addressed by the [number] shown in OBSERVATION. Never guess',
    '  a number that was not listed; observe again instead.',
    '- The page changes after most actions. Observe before acting on stale ids.',
    '- YOUR TABS is the complete list of pages you may work on: the one this',
    '  conversation belongs to, any the user named with "@", and any you open',
    '  yourself. Nothing else in the browser is yours — do not go hunting with',
    '  list_tabs or switch_tab, because every other tab is somebody\'s own work',
    '  and a tab you were not given is not part of this task.',
    '- When you HAVE been given several, the task is usually to move something',
    '  between them: read one, compare two, fill in a third. Do it in that',
    '  order and do it deliberately —',
    '    1. switch_tab to the source and observe it. If what you need is a list,',
    '       or spread down the page, use {"action":"observe","deep":true} — you',
    '       cannot come back for a detail you never read.',
    '    2. Say what you took in the "thought" of the next action. That is the',
    '       only place it survives: the observation of tab B replaces the',
    '       observation of tab A, so a value you did not write down is gone.',
    '    3. switch_tab to the target and fill it in from what you wrote down.',
    '  Do not try to read two tabs in one turn — you are shown one page at a',
    '  time — and do not guess a value you could not find. Ask for it.',
    '- If a link or button opens a new tab, you are moved there automatically',
    '  and told so. Carry on from the page you are shown rather than switching',
    '  back, unless the task needs the page you came from.',
    '- SCROLL is measured on what you are actually reading. With a dialog open',
    '  that is the DIALOG, so "more below" means more of the dialog, and scroll',
    '  moves the dialog — not the page behind it. A dialog is usually taller',
    '  than it looks: the Save or Submit button is very often below the fold of',
    '  it, and "there were no fields to fill in" is nearly always a dialog that',
    '  was never scrolled.',
    '- A long page shows you its first screenful only. If the task concerns all,',
    '  every, or the first N of something — jobs, results, rows, messages — your',
    '  first move is a deep observe. Counting or acting from what happened to be',
    '  on screen is the single most common way these runs go wrong: the page had',
    '  twenty-five and you answered about two.',
    '- PAGE NOTES means the page was read in parts and transcribed. It is the',
    '  whole page, not a sample — work from it rather than re-reading.',
    '- PAGE TEXT is only included when the page changed or you asked to observe.',
    '  If you need the wording of something, observe with a query.',
    '- If what you need is not in the text or the element list, take a',
    '  screenshot — do not answer around the gap and do not finish saying the',
    '  page was empty. A chart, a map, a diagram, a slide, a scanned or embedded',
    '  PDF, a canvas app and an image of a table all read as almost no text, and',
    '  every one of them is legible in a picture. An observation that is thin',
    '  where the task expects substance is the signal: look, then decide.',
    '- A screenshot is sometimes attached without you asking — after a step that',
    '  failed, one that changed nothing, a repeat of the step before, or a page',
    '  whose content is pixels rather than text. That is the signal that the',
    '  element list is not explaining the page: look at the picture and change',
    '  approach. Repeating the same click a third time never works.',
    '- DIALOG OPEN means a modal is in front of the page. Its buttons are the only',
    '  ones that can be clicked, and the element list already reflects that — so',
    '  do not go looking for the control you clicked to open it. Finish the',
    '  dialog, or close it.',
    '- Some steps need the user\'s approval. If one is refused, find another way',
    '  or finish and explain what you could not do.',
    '- Do not ask the user questions mid-run. Work with what the page gives you.',
    '- Do NOT add waits after clicking, typing or navigating. Every action',
    '  already returns only once the page has stopped changing, so a wait step',
    '  is pure dead time. Use wait only when a page shows a spinner that the',
    '  previous OBSERVATION proved is still running.',
    /**
     * The one instruction that stops "ask me first" from ending the run.
     *
     * A task that says "fill it in but check with me before submitting" has no
     * home in a vocabulary of page actions, so the model does the only thing
     * left and finishes with a question in its answer — which reads as a
     * request but IS the end of the run, so "yes" has nothing to go back to.
     * Named next to finish because that is what it gets confused with.
     */
    /**
     * When to stop and ask without being told to.
     *
     * The task is usually written before the page is seen, so it cannot name
     * the decision the page actually presents — "test the connector" does not
     * mention that testing it means authorising against a live Google account.
     * Left to itself the model does the reasonable next thing, and the first
     * the user hears of it is a credential prompt already half answered.
     *
     * Asking first is cheap: one prompt, and the answer arrives with whatever
     * values the step needed. Undoing a side effect is not cheap, and some of
     * these cannot be undone at all.
     */
    '- Stop and ask BEFORE anything that touches credentials, an account, a',
    '  payment, or the outside world: signing in, authorising, re-authorising,',
    '  creating or resetting a key or token, sending a message or email,',
    '  publishing, deleting, or spending money. Say what you are about to do and',
    '  why. The task was written before you saw the page, so it cannot have',
    '  ruled on the decision the page is actually putting in front of you.',
    '- When you need values to carry on — an ID, a name, a date, a credential —',
    '  ask for them as "fields" rather than describing them in a sentence. One',
    '  ask can carry several, and the answers come back labelled.',
    '- Once they say yes, say in one line how you will do that part before you',
    '  do it, then carry on with the task. Do not start again from the top and',
    '  do not re-survey the page: you already have YOUR PLAN, and this is a',
    '  detour within it, not a new job.',
    '- If the task says to ask, confirm, get permission, or not do something',
    '  without checking first: use ask. It waits for a real yes or no and the',
    '  run continues with it. Do NOT finish with a question in the answer —',
    '  that ends the run, and the user cannot answer a run that has stopped.',
    '- When you have the answer, use finish. Put the whole answer in "answer" —',
    '  the user only sees that, not your intermediate steps. Include every item',
    '  you found, not a sample of them, and say plainly which parts of the task',
    '  you did not manage.',
    /**
     * The answer is rendered as markdown, and nothing said so.
     *
     * The panel runs `lib/markdown.js` over it — headings, bullets, tables, code
     * fences, all of it. Told nothing, the model writes one paragraph with
     * "1)… 2)… 3)…" inside it, which renders as exactly what it is: a wall.
     * Measured on the Gmail run — five messages, each with a subject, a sender
     * and a summary, delivered as a single 90-word sentence. The information was
     * all there and none of it was findable.
     *
     * A list of items is the shape these tasks actually produce, so it is named
     * outright rather than left to "use markdown". The escaping is worth saying
     * too: the answer travels as a JSON string, so a literal newline breaks the
     * block and `parseAction` has to guess — which it can, but a truncated guess
     * costs a round trip.
     */
    '- Write the answer as MARKDOWN. It is rendered, so use it: "## " headings',
    '  when there is more than one part, "- " bullets for a list, "**bold**" for',
    '  the thing being named, a table when the items share fields. When the task',
    '  produced a set of items — messages, jobs, prices, results — give each one',
    '  its own bullet or row with its name in bold, never one paragraph with',
    '  "1)" and "2)" inside it. Keep it tight: the summary the user asked for,',
    '  not a transcript of the run.',
    '- Newlines inside "answer" must be written \\n, because the block is JSON.',
    `- Stop by step ${MAX_STEPS}; after that the run is cut off.`,
    '',
    'THE USER\'S TASK:',
    task
  ].join('\n');
}

/** Every action the loop and the page between them know how to carry out. */
const KNOWN = new Set([
  'observe', 'screenshot', 'click', 'type', 'select', 'scroll', 'click_at',
  'navigate', 'open_tab', 'switch_tab', 'list_tabs', 'use_frame', 'back', 'wait',
  'upload', 'ask', 'finish'
]);

/**
 * Names models reach for when they are not reading the vocabulary carefully.
 *
 * Every one of these was a run that knew exactly what it wanted to do and lost
 * a round trip to spelling. Rejecting them is defensible and useless: the model
 * does not learn from the correction, it just says "click_element" again.
 */
const ALIASES = new Map([
  ['click_element', 'click'], ['press', 'click'], ['tap', 'click'],
  ['type_text', 'type'], ['fill', 'type'], ['input', 'type'], ['enter_text', 'type'],
  ['select_option', 'select'], ['choose', 'select'],
  // Every one of these is a model that had the right idea about the file and
  // only missed the verb — the expensive way to lose a turn on a form.
  ['attach', 'upload'], ['attach_file', 'upload'], ['upload_file', 'upload'],
  ['set_file', 'upload'], ['choose_file', 'upload'], ['select_file', 'upload'],
  ['goto', 'navigate'], ['go_to', 'navigate'], ['open_url', 'navigate'], ['visit', 'navigate'],
  ['new_tab', 'open_tab'], ['open_new_tab', 'open_tab'],
  ['switch', 'switch_tab'], ['tabs', 'list_tabs'],
  ['enter_frame', 'use_frame'], ['frame', 'use_frame'], ['switch_frame', 'use_frame'],
  ['iframe', 'use_frame'], ['exit_frame', 'use_frame'],
  ['screen_shot', 'screenshot'], ['capture', 'screenshot'], ['look', 'screenshot'],
  ['read', 'observe'], ['read_page', 'observe'], ['extract', 'observe'],
  ['observe_page', 'observe'], ['inspect', 'observe'],
  // Asking has more obvious names than most actions, and a model that reaches
  // for one of them has already decided to ask — losing that to "not an action"
  // turns a correct instinct into a wasted round trip.
  ['ask_user', 'ask'], ['confirm', 'ask'], ['request_approval', 'ask'],
  ['ask_permission', 'ask'], ['prompt_user', 'ask'],
  ['done', 'finish'], ['answer', 'finish'], ['complete', 'finish'],
  ['final_answer', 'finish'], ['respond', 'finish'],
  ['go_back', 'back'],
  ['click_point', 'click_at'], ['click_coordinates', 'click_at'],
  ['click_xy', 'click_at'], ['mouse_click', 'click_at'], ['tap_at', 'click_at']
]);

/** Names for "photograph the whole thing", which is a scope, not an action. */
const FULL_SHOT = new Set([
  'full_screenshot', 'screenshot_full', 'fullpage_screenshot', 'full_page_screenshot',
  'capture_full_page', 'screenshot_page', 'page_screenshot', 'whole_page_screenshot'
]);

/** Keys models use for "the number I want to act on". */
const ID_KEYS = ['id', 'index', 'element', 'element_id', 'elementId', 'target', 'idx'];

/**
 * Pull the action out of a reply.
 *
 * Lenient on purpose, and the leniency is the feature. The reply comes out of a
 * chat window, not a function-calling API: there is no schema enforcement
 * anywhere in the path, so every drift the model has — a nested action object,
 * `"index"` instead of `"id"`, a fence it forgot to close, a trailing comma —
 * arrives here as prose that "could not be read", costs a whole round trip, and
 * sometimes repeats. Each shape below is one of those, and none of them is a
 * case where the model's intent was actually unclear.
 *
 * What it will not do is invent intent. A reply with no action-shaped object in
 * it is reported as such, and the loop decides what that means.
 */
/**
 * Pull a list of actions out of one object, whatever shape it arrived in.
 *
 * `{"actions":[…]}` is what the prompt asks for, but a model that has been told
 * it may send several will also send a bare array, wrap it in `{"steps":…}`, or
 * put a single action alongside a list. All of those are unambiguous; refusing
 * them would cost a round trip to teach a distinction that does not matter.
 */
function actionsWithin(value) {
  if (!value || typeof value !== 'object') return [];

  if (Array.isArray(value)) return value.flatMap(actionsWithin);

  const list = value.actions || value.steps || value.plan;
  if (Array.isArray(list)) {
    const batch = list.flatMap(actionsWithin);
    if (batch.length) return batch;
  }

  return value.action ? [value] : [];
}

/**
 * One reply's worth of actions, capped and truncated at the first `finish`.
 *
 * `action` is still the first one, because everything downstream that reports a
 * single action — the step note, the repeat detection, the vision triggers —
 * reads it. Anything after a `finish` is dropped rather than run: the model
 * saying it is done and then clicking three more things is a contradiction, and
 * the safe reading of it is the one that stops.
 */
function asBatch(actions) {
  /**
   * `ask` ends a batch for the same reason `finish` does.
   *
   * Everything queued after a question was planned without knowing the answer —
   * a batch of [ask "shall I submit?", click Submit] submits the form either
   * way, which is precisely the thing the question was asked to prevent. The
   * next turn gets the answer in its RESULT and plans from there.
   */
  const upTo = actions.findIndex((a) => a.action === 'finish' || a.action === 'ask');
  const kept = (upTo === -1 ? actions : actions.slice(0, upTo + 1)).slice(
    0,
    MAX_BATCH_ACTIONS
  );

  return {
    action: kept[0],
    actions: kept,
    dropped: actions.length - kept.length
  };
}

export function parseAction(reply) {
  if (!reply || !reply.trim()) return { error: 'Empty reply.' };

  const candidates = [];
  const push = (raw) => raw && raw.trim() && candidates.push(raw.trim());

  // Fenced blocks first, in order of how deliberate they are. The unterminated
  // variant matters more than it looks: a reply read while the provider was
  // still streaming ends mid-block, and its content is complete far more often
  // than the fence around it is.
  for (const m of reply.matchAll(/```(?:json|javascript|js)?\s*([\s\S]*?)```/gi)) push(m[1]);
  for (const m of reply.matchAll(/~~~(?:json)?\s*([\s\S]*?)~~~/gi)) push(m[1]);
  const unterminated = reply.match(/```(?:json)?\s*([\s\S]*)$/i);
  if (unterminated && !reply.trimEnd().endsWith('```')) push(unterminated[1]);

  // Then every balanced object in the raw text, not just the first: models
  // narrate ("I'll use {"action":"click"} next…"), quote the vocabulary back,
  // or put a worked example ahead of the real thing.
  for (const raw of balancedObjects(reply)) push(raw);

  let fallback = null;

  for (const raw of candidates) {
    const parsed = parseLoosely(raw);
    const batch = actionsWithin(parsed).map(normalise).filter(Boolean);
    if (!batch.length) continue;

    // A known action anywhere beats an unknown one earlier in the reply — an
    // invented name usually comes from a model quoting itself, not deciding.
    if (batch.some((a) => KNOWN.has(a.action))) return asBatch(batch);
    if (!fallback) fallback = batch;
  }

  // An unknown name still goes through: performAction reports it by name, which
  // corrects the model far better than "that was not an action" does.
  if (fallback) return asBatch(fallback);

  /**
   * An odd number of fences means the reply we were handed stops inside a code
   * block, which is a different failure with a different fix: the model did
   * write an action, and we read the page before it had finished rendering.
   * Saying "answer with a json block" to a model that just did exactly that is
   * how a run spends three turns arguing about a transport problem.
   */
  if ((reply.match(/```/g) || []).length % 2 === 1) {
    return {
      truncated: true,
      error:
        'That reply reached us cut off inside a code block, so the action was ' +
        'incomplete. Send the same action again as one complete ```json block.'
    };
  }

  return {
    error:
      'Could not read an action from that reply. Answer with a single ```json ' +
      'block containing an "action" field.'
  };
}

/** JSON, then JSON with the mistakes models actually make repaired. */
function parseLoosely(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through to the repair */
  }

  const repaired = quoteBareKeys(
    raw
      // Smart quotes: a chat UI leaves code blocks alone, but a model writing the
      // object inline in prose picks them up from the prose around it.
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/^\s*json\b/i, '')
      .trim()
  );

  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

/**
 * `{"x":212,y:338}` — one key that lost its quotes, and the whole turn with it.
 *
 * Observed, not hypothetical: a model wrote a perfect `click_at` and quoted
 * every key but the last one. `JSON.parse` refuses the object, nothing else in
 * the repair chain touches it, and the run reported "Could not read an action
 * from that reply" — a wasted round trip, and one the model is unlikely to fix
 * on the retry because it cannot see what was wrong with what it sent. It is the
 * same family as the trailing comma and the smart quote above: the model decided
 * correctly and typed it badly.
 *
 * A scanner rather than a regex, and that is the whole point. The obvious
 * version — quote any word followed by a colon after `{` or `,` — reaches inside
 * string VALUES, where models routinely write things like
 * `"thought":"go to a, b: c"`, and rewrites them into nonsense. So this walks
 * the text tracking whether it is inside a string, and only quotes a bare word
 * that is in key position: immediately after `{` or `,`, and immediately before
 * a colon.
 */
function quoteBareKeys(raw) {
  let out = '';
  let quote = null;
  // The last character that was not whitespace, which is what says "a key may
  // start here". Tracked rather than re-scanned so this stays linear.
  let previous = '';

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (quote) {
      out += ch;
      // A backslash escapes the next character, including the closing quote —
      // without this, `"he said \"hi\""` ends the string in the wrong place and
      // everything after it is scanned as if it were structure.
      if (ch === '\\') out += raw[++i] ?? '';
      else if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      previous = ch;
      continue;
    }

    if ((previous === '{' || previous === ',') && /[A-Za-z_$]/.test(ch)) {
      const word = /^[\w$]+/.exec(raw.slice(i))[0];
      if (/^\s*:/.test(raw.slice(i + word.length))) {
        out += `"${word}"`;
        i += word.length - 1;
        // Anything but '{' or ',', so the value that follows is never mistaken
        // for another key.
        previous = '"';
        continue;
      }
    }

    out += ch;
    if (!/\s/.test(ch)) previous = ch;
  }

  return out;
}

/**
 * Every top-level {...} in the text, in order.
 *
 * The scan ignores braces inside strings, or an action carrying JSON in one of
 * its own values — a `type` whose text is an object, most obviously — ends
 * early and fails to parse.
 */
function balancedObjects(text) {
  const found = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        found.push(text.slice(start, i + 1));
        if (found.length >= 8) break;
      }
    }
  }

  return found;
}

/** One parsed object, in the shape the loop expects — or null if it is not one. */
function normalise(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  // {"thought":"…","action":{"type":"click","id":3}} — the nested form. Flatten
  // it rather than reject it; the intent is not ambiguous.
  let node = parsed;
  if (node.action && typeof node.action === 'object' && !Array.isArray(node.action)) {
    const inner = node.action;
    node = { ...node, ...inner, action: inner.action || inner.type || inner.name };
  }

  let name = node.action ?? node.tool ?? node.name ?? node.command;

  // {"answer":"…"} with no action at all is a finish that forgot to say so, and
  // it is always the last turn of a run — the expensive one to throw away.
  if (typeof name !== 'string' && typeof node.answer === 'string') name = 'finish';
  if (typeof name !== 'string' || !name.trim()) return null;

  const key = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const action = { ...node, action: ALIASES.get(key) || key };

  /**
   * "Photograph the whole page", however it was asked for.
   *
   * A model that wants the full page reaches for a verb before it reaches for
   * an argument, and `full_page_screenshot` would otherwise arrive as an
   * unknown action — reported by name, which corrects it eventually, at the
   * price of a round trip per attempt.
   */
  if (FULL_SHOT.has(key)) {
    action.action = 'screenshot';
    action.scope = 'full';
  }
  if (action.action === 'screenshot') {
    if (node.full === true || node.fullPage === true || node.full_page === true) {
      action.scope = 'full';
    }
    if (node.load === true || node.loadAll === true || node.load_all === true) {
      action.scope = action.scope || 'full';
      action.load = true;
    }
  }

  /**
   * A coordinate pair, however the model chose to package it.
   *
   * `{"x":5,"y":9}`, `{"point":[5,9]}` and `{"coordinates":{"x":5,"y":9}}` have
   * all turned up, and an unread coordinate is not a small failure: the action
   * still runs, aimed at (NaN, NaN), and the note says nothing was there.
   *
   * `type` reads them too — it is the other half of the screenshot escape
   * hatch, and a field you can click but cannot fill in is no escape at all.
   * Only written when they are real numbers, so an ordinary `type` by id does
   * not carry a pair of NaNs through the log.
   */
  if (action.action === 'click_at' || action.action === 'type') {
    const point = node.point || node.coordinates || node.coords || node.at;
    const from = Array.isArray(point)
      ? { x: point[0], y: point[1] }
      : point && typeof point === 'object'
        ? point
        : node;

    const x = Number(from.x ?? node.x);
    const y = Number(from.y ?? node.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      action.x = Math.round(x);
      action.y = Math.round(y);
    }
  }

  // switch_tab is addressed by a browser tab id, not by an element number, and
  // conflating the two would send the agent to a tab it never listed.
  if (action.action === 'switch_tab') {
    const tab = node.tabId ?? node.tab_id ?? node.id ?? node.index;
    if (Number.isFinite(Number(tab))) action.tabId = Number(tab);
  } else {
    for (const id of ID_KEYS) {
      if (node[id] != null && Number.isFinite(Number(node[id]))) {
        action.id = Number(node[id]);
        break;
      }
    }
  }

  if (action.action === 'finish' && typeof action.answer !== 'string') {
    action.answer = node.text || node.result || node.summary || node.content || '';
  }

  return action;
}

/**
 * What every turn ends with. The task, then the format, then nothing.
 *
 * This exists because the first turn used to end differently from all the
 * others — and the first turn is the one that failed. It is also the longest
 * message of the run: the rules, then the task, then up to forty thousand
 * characters of page. By the end of it the instruction to reply with an action
 * is ten thousand characters back and the last thing the model has read is a
 * list of jobs, so it does the thing that list invites and describes them. Then
 * the run reports "Reply was not an action" and spends a step recovering from a
 * prompt that never asked for one clearly enough.
 *
 * The task is restated for the same reason: twenty steps into a thread, the
 * original instruction is a long way up, and "apply to five of these" has to
 * still be the thing being answered on step twenty.
 */
/**
 * The tabs this run may work on, restated every turn.
 *
 * Beside the task and the plan rather than in the first message, and for the
 * same reason: a list sent once is twenty turns up the thread by the time the
 * model needs to switch, and a tab it can no longer see is a tab it has
 * forgotten it was given. It is three short lines, so recency is cheap.
 *
 * Titles, not just ids. The user writes "fill in the application" — they never
 * write the number Chrome assigned the tab, so a bare list of ids leaves the
 * model matching a task written in names against a list written in numbers,
 * and it guesses. `switch_tab` still takes the id; this is what lets it pick
 * the right one.
 *
 * Empty for a single-tab run: "YOUR TABS: 1" is a paragraph of prompt telling
 * the model something it cannot act on, and it invites switching where there
 * is nowhere to switch to.
 */
function tabBlock(tabs, currentTab) {
  if (!Array.isArray(tabs) || tabs.length < 2) return [];

  return [
    'YOUR TABS — these are the only pages you may work on:',
    ...tabs.map(
      (t) =>
        `  tabId=${t.id}${t.id === currentTab ? '  <- you are here' : ''}  “${t.title}”` +
        (t.url ? `  ${t.url}` : '')
    ),
    'Move between them with {"action":"switch_tab","tabId":…}. You see one page',
    'at a time, so carry anything you need from one to the next in your',
    '"thought" — switching replaces the observation, not adds to it.',
    ''
  ];
}

/**
 * `survey` is the format spec for a first turn that plans AND acts.
 *
 * Passed in as text rather than imported, because `plan.js` owns the wording
 * and importing it here would close a ring — plan.js already reaches into
 * this file. When it is present the closing demand changes shape: the reply
 * is a document with an action block inside it rather than an action block
 * and nothing else, and the two instructions cannot both be at the end of the
 * message. See SURVEY_FORMAT for why the halves are ordered as they are.
 */
export function closing(
  task,
  plan = '',
  {
    tabs = null,
    currentTab = null,
    mayAsk = true,
    survey = '',
    newTask = false,
    blind = false
  } = {}
) {
  return [
    '',
    '',
    ...tabBlock(tabs, currentTab),
    /**
     * Said up front, not discovered by being refused.
     *
     * The vocabulary above offers `ask`, and the model reaches for it before
     * anything that submits — which is the right instinct and exactly what the
     * user switched off. `actions.js` refuses it, but a refusal costs a full
     * provider round trip and the model often just rephrases the same question.
     * Telling it here, in the block that is repeated every turn, is cheaper and
     * it works: recency is on our side at the end of the message.
     */
    ...(mayAsk
      ? []
      : [
          'THE USER IS NOT WATCHING. They set this run to never stop for',
          'approval, so nobody will answer a question — {"action":"ask"} will be',
          'refused. Where you would have asked, decide it yourself from the task',
          'and the page and carry on. If something genuinely cannot be decided',
          'without them, finish and say what you left undone and why.',
          ''
        ]),
    // Restated every turn for the same reason the task is: a plan agreed on
    // turn one is a long way up the thread by turn twenty, and a plan the
    // model has stopped being able to see is a plan it has stopped following.
    // Named YOUR PLAN, not THE PLAN — it is the model's own reasoning handed
    // back, which it argues with far less than an instruction from outside.
    ...(plan
      ? [
          'YOUR PLAN, from looking at the whole page before you started:',
          plan,
          '',
          'Follow it, and send every step of it that the observation below already',
          'supports as ONE batch — that is what the plan was for. Do not re-derive',
          'it. If the page turns out to differ from it, the page wins: say so in',
          'your "thought" and carry on from what is actually there.',
          ''
        ]
      : []),
    `THE USER'S TASK: ${task}`,
    '',
    /**
     * The thread above is finished work, and saying so at the top did not take.
     *
     * `run.js` opens the first prompt with NEW_TASK_BANNER, which is correct
     * and is not enough: everything between it and here is the element list and
     * the page, thousands of characters of it, and what the model acts on is
     * what it read last. Measured — a chat whose previous run had read Gmail,
     * given an unrelated task, spent its steps on "the navigation to Gmail
     * failed with a 301 redirect, I will observe the current state". The panel
     * showed the new task throughout, so from outside the run simply did
     * something nobody asked for.
     *
     * Placed after the task and before the format demand deliberately: it is
     * about WHICH task, so it belongs next to the task, and the last thing read
     * must still be the shape of the reply.
     */
    ...(newTask
      ? [
          'THAT TASK, AND ONLY THAT TASK. Everything earlier in this conversation',
          'is over — a task that already finished, or a question the user asked in',
          'this same chat. Do not continue it, do not repeat it, do not report on',
          'it, and do not answer any question left open up there. If your last',
          'reply in this thread was about a different site or a different goal,',
          'that was the old task: drop it. Look at the page you have been given',
          'above and act on the task named here.',
          ''
        ]
      : []),
    /**
     * Said BEFORE it happens, because the correction afterwards costs a round
     * trip and often does not work.
     *
     * A research-shaped task — "find the free video tools, compare them, give
     * me a table" — is one the model believes it already knows the answer to.
     * So it writes the answer out: no page opened, no page read, every claim
     * from memory, and the run ends at zero steps with something fluent enough
     * that nobody can tell. It is the same failure as promising rather than
     * doing, one move earlier, and it needs saying in the block that is
     * repeated every turn rather than only in the push-back after the fact.
     */
    /**
     * No camera on this run, said before it is discovered by being refused.
     *
     * The same shape as `mayAsk`: the model reaches for a screenshot when the
     * element list stops explaining a page, which is the right instinct, and
     * finding out it cannot have one costs a full provider round trip. Worse,
     * the failure mode next door is a model that believes a picture arrived and
     * invents coordinates for it — so the useful thing to say is not "no" but
     * "there will never be one, and here is what to do instead".
     */
    ...(blind
      ? [
          'THERE IS NO CAMERA ON THIS RUN. No screenshot will ever be attached to',
          'any turn, and {"action":"screenshot"} will be declined — this provider',
          'is being reached the fast way, which cannot carry a picture. Work from',
          'the page text and the numbered elements. Never guess at x/y',
          'coordinates: with no picture, click_at and a typed x/y are aiming at',
          'nothing. If a page turns out to be unreadable as text — a canvas, a',
          'video, a scanned PDF — say exactly that and finish, rather than',
          'describing what you think is on it.',
          ''
        ]
      : []),
    'Your own knowledge is not an answer here. Whatever you already believe',
    'about the subject, this task is to go and look: open the pages, read what',
    'is actually on them, and build the answer from what you found. Writing it',
    'out from memory is the one failure that is indistinguishable from success,',
    'so it is worth being blunt — if you have not opened anything yet, the next',
    'action is a search or a navigation, never prose.',
    '',
    /**
     * Two shapes, and the survey one has to win when it is set.
     *
     * "Reply with ONE fenced block and NOTHING else" is exactly right for
     * every ordinary turn and exactly wrong for the first one, which is now
     * asked for a route as well. Leaving both in produced the failure this
     * whole merge was meant to remove, one layer along: a model that obeys
     * the last thing it read writes the block alone, the route is lost, and
     * every later turn runs without a plan.
     */
    ...(survey
      ? [survey]
      : [
          'Reply with ONE fenced ```json block containing an "action", and nothing',
          'else. Not a summary, not a question, not an offer to help — those end the',
          'turn without doing anything. If the task is done, that is',
          '{"action":"finish","answer":"…"}.'
        ])
  ].join('\n');
}

/**
 * One observation, in the shape the model was told to expect.
 *
 * `image` says a screenshot is attached to this same turn. It is stated here
 * rather than tacked on by the caller so the picture is described in the middle
 * of the page state it belongs to — a model told "an image is attached" three
 * paragraphs later tends to read it as a picture of some earlier step.
 */
export function renderObservation(step, observation, { image = false } = {}) {
  const lines = [`OBSERVATION (step ${step})`, `URL: ${observation.url}`];

  lines.push(`TITLE: ${observation.title}`);

  if (observation.modal) {
    lines.push(
      `DIALOG OPEN: “${observation.modal}” — it blocks the page behind it, so ` +
        'only this dialog’s own controls and text are listed. Work inside it, or ' +
        'close it if the task is elsewhere.'
    );
  }

  lines.push(
    `SCROLL: ${observation.scroll}%${observation.moreBelow ? ' (more below)' : ' (at end)'}`
  );

  if (image) {
    const view = observation.viewport;
    lines.push(
      'SCREENSHOT: attached to this message. It is this exact page state — the ' +
        'numbered elements below are what is in it. Use it to work out what the ' +
        'text could not tell you.'
    );
    // Without the size, a coordinate is a guess: the model is looking at a
    // picture and has no other way to know what one pixel of it is worth.
    if (view?.width) {
      lines.push(
        `VIEWPORT: ${view.width}×${view.height}. The picture is that window, so ` +
          'anything you can see in it can be clicked with ' +
          '{"action":"click_at","x":…,"y":…} measured from its top-left corner.'
      );
    }
  }

  lines.push('', 'INTERACTIVE ELEMENTS:');
  lines.push(observation.elements.length ? observation.elements.join('\n') : '(none found)');

  /**
   * The range, stated, because the model guesses past it and pays a round trip.
   *
   * `indexElements` RENUMBERS from zero on every observation and caps at
   * MAX_ELEMENTS, so an id is only meaningful against the list it came with.
   * Nothing said so, and the failure mode is expensive and repeatable: measured
   * on a Wikipedia run, `{"action":"click","id":137}` and `{"action":"type",
   * "id":128}` on a page whose cap is 120 — two ids that have never existed,
   * each costing a failed step, a re-observation and a screenshot.
   *
   * Saying "these are the only ones" is what closes it. A model that knows the
   * range picks from the list; one that does not treats the numbers as page
   * coordinates that persist, which is exactly what they are not.
   */
  if (observation.elements.length) {
    lines.push(
      `(Numbered [0]–[${observation.elements.length - 1}]. Those are the ONLY ids that exist ` +
        'here. They are renumbered on every observation, so an id from an earlier step means ' +
        'nothing now — always pick from the list above.)'
    );
  }

  if (observation.omitted) {
    lines.push(
      `(${observation.omitted} further off-screen controls exist. They have NO number and ` +
        'cannot be clicked or typed into. Scroll to bring them on screen and the next ' +
        'observation will number them.)'
    );
  }

  /**
   * Say what the silence means.
   *
   * An observation with no PAGE TEXT is ambiguous — the page may be empty, or
   * it may be a chart with everything in it. Left unexplained, a model treats
   * both as empty and answers accordingly. The census comes from the content
   * script; it is only mentioned when there is genuinely nothing to read.
   */
  const visual = observation.visual;
  if (visual && (visual.chars ?? Infinity) < 220) {
    const holds = [
      visual.canvas && `${visual.canvas} canvas`,
      visual.image && `${visual.image} large image${visual.image > 1 ? 's' : ''}`,
      visual.video && `${visual.video} video`,
      visual.embed && `${visual.embed} embedded frame${visual.embed > 1 ? 's' : ''}`
    ]
      .filter(Boolean)
      .join(', ');

    if (holds) {
      lines.push(
        '',
        `NOTE: this page has almost no readable text but holds ${holds}. Its ` +
          'content is pixels, not markup — if the task needs what is in there, ' +
          'take a screenshot rather than concluding the page is empty.'
      );
    }
  }

  /**
   * Frames are named whatever the page says, not only when it is textless.
   *
   * The visual census above only speaks up for a page with under 220
   * characters, which is right for a chart and exactly wrong for this: a job
   * board with the application in an iframe is thousands of characters of
   * perfectly readable listing, so the one thing the model needed to know was
   * the one thing suppressed. It then read a complete-looking element list,
   * could not find the form it had been told to fill, and reported that the
   * page had no such form — twice, in a row, with the form on screen.
   *
   * The numbering is separate from element ids on purpose. They index
   * different things and are used by different actions, and reusing one series
   * for both would produce a use_frame aimed at a button.
   */
  const frames = observation.frames || [];
  if (frames.length) {
    lines.push(
      '',
      'FRAMES ON THIS PAGE (separate documents — nothing inside them is in the',
      'element list above, and none of it can be clicked from here):'
    );
    frames.forEach((frame, index) => {
      lines.push(
        `  (frame ${index + 1}) "${frame.name}" ${frame.width}x${frame.height}` +
          `${frame.onScreen ? ' on screen' : ' off screen'}${frame.url ? ` — ${frame.url}` : ''}`
      );
    });
    lines.push(
      'If what the task needs is not in the element list, it is very likely in',
      'one of these — an embedded form, a chat widget, a booking or payment box.',
      'Go in with {"action":"use_frame","frame":1} and you will be shown that',
      'document\'s own elements; {"action":"use_frame","frame":0} comes back out.',
      'Do NOT conclude the page is missing a field until you have looked inside.'
    );
  }

  if (observation.text) {
    // Naming the deep read matters: told only "PAGE TEXT", a model treats a
    // scrolled-and-transcribed page exactly as it treats one screenful, and
    // hedges an answer it now has every right to give completely.
    // The deep readings need the second sentence as much as the first. Told
    // only that the text is complete, a model reads twenty-five items and acts
    // as though twenty-five were clickable — but the element list is live
    // references to what is rendered now, and a list renders a screenful at a
    // time. The text is the inventory; the numbers are the reach.
    const heading = observation.modal
      ? 'DIALOG TEXT:'
      : observation.readInParts
        ? `PAGE NOTES (the whole page, scrolled through ${observation.passes || 1} ` +
          'screenfuls and transcribed part by part — this is all of it. The ' +
          'numbered elements above are only the part on screen now; scroll to ' +
          'reach anything listed here that has no number):'
        : observation.passes > 1
          ? `PAGE TEXT (scrolled through ${observation.passes} screenfuls — this is the ` +
            'whole page. The numbered elements above are only what is on screen ' +
            'now; scroll to reach the rest):'
          : 'PAGE TEXT:';

    lines.push('', heading, observation.text);
  }

  return lines.join('\n');
}

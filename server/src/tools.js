// MCP tool definitions. The browser extension implements each tool with the same name and
// arguments (extension/background/tools/). Keep names short and descriptions tight: every MCP
// session pays for these tokens.

const tab = { type: 'integer', description: 'Tab id from list_tabs. Default: the current tab.' };
const ref = { type: 'integer', minimum: 1, description: 'Element number from read_page (interactive mode) or find. Invalid after navigation.' };
const selector = { type: 'string', minLength: 1, maxLength: 2000, description: 'CSS selector (the first visible match, else the first match).' };
const selectorFirst = { type: 'string', minLength: 1, maxLength: 2000, description: 'CSS selector (the first match, visible or not).' };
const x = { type: 'number', description: 'Viewport x in CSS pixels (= screenshot pixels unless the screenshot was scaled).' };
const y = { type: 'number', description: 'Viewport y in CSS pixels.' };
const timeout = (def, max) => ({ type: 'integer', minimum: 100, maximum: max, description: `Milliseconds, default ${def}.` });

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const ACT = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const DANGER = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/** @type {Array<{name: string, title: string, description: string, inputSchema: object, annotations: object, timeoutMs?: (args: object) => number}>} */
export const TOOLS = [
  {
    name: 'list_tabs',
    title: 'List shared tabs',
    description: 'List the tabs shared with you (the browser\'s "cctether" tab group) and browser info. Only these tabs can be used. To use another page, open it with open_tab, or ask the user to share it (cctether toolbar button → "Share this tab").',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ,
  },
  {
    name: 'open_tab',
    title: 'Open tab',
    description: 'Open a new tab in the cctether group and make it the current tab. Waits for the page to load.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', maxLength: 8192, description: 'Default about:blank.' },
        active: { type: 'boolean', description: 'Bring the tab to the front. Default false, so the user\'s own browsing is not interrupted.' },
      },
      additionalProperties: false,
    },
    annotations: ACT,
    timeoutMs: () => 35000,
  },
  {
    name: 'close_tab',
    title: 'Close tab',
    description: 'Close a tab in the cctether group.',
    inputSchema: { type: 'object', properties: { tab }, required: ['tab'], additionalProperties: false },
    annotations: DANGER,
  },
  {
    name: 'navigate',
    title: 'Navigate',
    description: 'Load a URL in a tab, or go back / forward / reload. Waits for the page to load.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', maxLength: 8192 },
        action: { type: 'string', enum: ['back', 'forward', 'reload'], description: 'Instead of url.' },
        tab,
        timeout_ms: timeout(30000, 120000),
      },
      additionalProperties: false,
    },
    annotations: ACT,
    timeoutMs: (a) => (a.timeout_ms ?? 30000) + 5000,
  },
  {
    name: 'read_page',
    title: 'Read page',
    description: 'Read the page. mode "text" (default): visible text. "interactive": numbered list of links, buttons, inputs etc. — pass a number as `ref` to click/type/hover/select_option/scroll/screenshot. "html": HTML of `selector` (default body). Long output is split: pass the returned offset to continue.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['text', 'interactive', 'html'] },
        selector: { ...selector, description: 'Limit to this element (CSS selector; the first visible match, or for "html" the first match).' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset to continue from.' },
        max_chars: { type: 'integer', minimum: 500, maximum: 100000, description: 'Default 20000.' },
        tab,
      },
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'find',
    title: 'Find elements',
    description: 'Find elements by CSS selector. Returns count, and for each: ref number, tag, text, key attributes, position, visibility.',
    inputSchema: {
      type: 'object',
      properties: {
        selector,
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 20.' },
        tab,
      },
      required: ['selector'],
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'screenshot',
    title: 'Screenshot',
    description: 'Screenshot the visible area (default), the full page, or one element (ref or selector).',
    inputSchema: {
      type: 'object',
      properties: {
        full_page: { type: 'boolean' },
        ref,
        selector,
        format: { type: 'string', enum: ['jpeg', 'png'], description: 'Default jpeg.' },
        quality: { type: 'integer', minimum: 1, maximum: 100, description: 'JPEG quality, default 75.' },
        tab,
      },
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'click',
    title: 'Click',
    description: 'Click an element (ref or selector) or a point (x, y) with real mouse events. Scrolls the element into view first.',
    inputSchema: {
      type: 'object',
      properties: {
        ref, selector, x, y,
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        click_count: { type: 'integer', minimum: 1, maximum: 3, description: '2 = double click.' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] }, maxItems: 4 },
        tab,
      },
      additionalProperties: false,
    },
    annotations: ACT,
  },
  {
    name: 'type',
    title: 'Type text',
    description: 'Type text into an element (ref or selector; it gets focused first) or into the focused element.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: 100000 },
        ref, selector,
        clear: { type: 'boolean', description: 'Delete the existing value first.' },
        submit: { type: 'boolean', description: 'Press Enter afterwards.' },
        tab,
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: ACT,
  },
  {
    name: 'press_key',
    title: 'Press key',
    description: 'Press a key or combination, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+A", "Meta+Shift+P". If the browser is on macOS (list_tabs says), editing shortcuts use Meta: Meta+A, Meta+C, Meta+V.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', minLength: 1, maxLength: 100 },
        repeat: { type: 'integer', minimum: 1, maximum: 50 },
        tab,
      },
      required: ['key'],
      additionalProperties: false,
    },
    annotations: ACT,
  },
  {
    name: 'scroll',
    title: 'Scroll',
    description: 'Scroll an element into view (ref or selector), or scroll the page — or the scrollable element under (x, y) — in a direction.',
    inputSchema: {
      type: 'object',
      properties: {
        ref, selector,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', minimum: 1, maximum: 100000, description: 'Pixels, default 80% of the viewport.' },
        x, y,
        tab,
      },
      additionalProperties: false,
    },
    annotations: ACT,
  },
  {
    name: 'hover',
    title: 'Hover',
    description: 'Move the mouse over an element (ref or selector) or a point (x, y).',
    inputSchema: { type: 'object', properties: { ref, selector, x, y, tab }, additionalProperties: false },
    annotations: ACT,
  },
  {
    name: 'select_option',
    title: 'Select option',
    description: 'Choose option(s) in a <select>, matching each value against option value, then visible label.',
    inputSchema: {
      type: 'object',
      properties: {
        ref, selector: selectorFirst,
        value: { type: ['string', 'array'], items: { type: 'string' }, maxItems: 100, description: 'One value, or several for a multi-select.' },
        tab,
      },
      required: ['value'],
      additionalProperties: false,
    },
    annotations: ACT,
  },
  {
    name: 'wait_for',
    title: 'Wait for',
    description: 'Wait until text appears on the page, or an element matching selector appears (with gone: true, until it disappears).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 1000 },
        selector,
        gone: { type: 'boolean' },
        timeout_ms: timeout(10000, 120000),
        tab,
      },
      additionalProperties: false,
    },
    annotations: READ,
    timeoutMs: (a) => (a.timeout_ms ?? 10000) + 5000,
  },
  {
    name: 'evaluate',
    title: 'Run JavaScript',
    description: 'Run JavaScript in the page and return the result as JSON. Works like the DevTools console: the value of the last expression is returned, top-level await is allowed. world "page" (default) shares globals with the page; "isolated" sees only the DOM.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', minLength: 1, maxLength: 200000 },
        world: { type: 'string', enum: ['page', 'isolated'] },
        timeout_ms: timeout(10000, 120000),
        tab,
      },
      required: ['expression'],
      additionalProperties: false,
    },
    annotations: DANGER,
    timeoutMs: (a) => (a.timeout_ms ?? 10000) + 5000,
  },
  {
    name: 'console_messages',
    title: 'Console messages',
    description: 'Read console messages and uncaught errors of a tab, including ones from extension content scripts (labelled with the extension name). Newest last.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['error', 'warning', 'all'], description: '"error": errors only; "warning": warnings and errors; default "all".' },
        pattern: { type: 'string', maxLength: 500, description: 'Only messages containing this text (case-insensitive).' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 50 (the newest).' },
        clear: { type: 'boolean', description: 'Clear the buffer after reading.' },
        tab,
      },
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'network_requests',
    title: 'Network requests',
    description: 'List network requests of a tab, newest last. With id: headers and body of one request.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1, description: 'Request number from the list.' },
        pattern: { type: 'string', maxLength: 500, description: 'Only URLs containing this text.' },
        type: { type: 'string', enum: ['document', 'xhr', 'fetch', 'script', 'stylesheet', 'image', 'font', 'media', 'websocket', 'other'] },
        failed: { type: 'boolean', description: 'Only failed requests and HTTP errors (status >= 400).' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 50 (the newest).' },
        clear: { type: 'boolean', description: 'Clear the list after reading.' },
        tab,
      },
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'handle_dialog',
    title: 'Handle dialog',
    description: 'Accept or dismiss the alert / confirm / prompt open in a tab. While one is open, the page is frozen and other tools on it fail.',
    inputSchema: {
      type: 'object',
      properties: {
        accept: { type: 'boolean' },
        text: { type: 'string', maxLength: 10000, description: 'Answer for a prompt.' },
        tab,
      },
      required: ['accept'],
      additionalProperties: false,
    },
    annotations: ACT,
  },
  {
    name: 'list_extensions',
    title: 'List extensions',
    description: 'List installed browser extensions. "unpacked" ones are loaded from a folder (in development).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ,
  },
  {
    name: 'reload_extension',
    title: 'Reload extension',
    description: 'Reload an extension by turning it off and on. Picks up changed code (background, content scripts, pages) but NOT manifest.json changes — for those, ask the user to click the reload button on chrome://extensions. Reload open tabs to get new content scripts.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[a-p]{32}$' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: DANGER,
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
export const DEFAULT_TIMEOUT_MS = 30000;

export function toolTimeoutMs(name, args) {
  const t = TOOLS.find((x) => x.name === name);
  return t?.timeoutMs ? t.timeoutMs(args) : DEFAULT_TIMEOUT_MS;
}

/** Tool list as sent in MCP tools/list. */
export function mcpToolList() {
  return TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
    name, title, description, inputSchema, annotations: { title, ...annotations },
  }));
}

// MCP tool definitions. The browser extension implements each tool with the same name and
// arguments (extension/background/tools/). Keep names short and descriptions tight: every MCP
// session pays for these tokens.

const tab = { type: 'integer', description: 'Tab id from list_tabs. Default: the current tab.' };
const ref = { type: 'integer', minimum: 1, description: 'Element number from read_page (interactive mode) or find. Invalid after navigation.' };
const selector = { type: 'string', minLength: 1, maxLength: 2000, description: 'CSS selector (the first visible match, else the first match; in same-origin iframes if the page itself has no match).' };
const selectorFirst = { type: 'string', minLength: 1, maxLength: 2000, description: 'CSS selector (the first match, visible or not).' };
const x = { type: 'number', description: 'Viewport x in CSS pixels, or with screenshot: x on that image.' };
const y = { type: 'number', description: 'Viewport y in CSS pixels, or with screenshot: y on that image.' };
const text = { type: 'string', minLength: 1, maxLength: 1000, description: 'Visible text or aria-label of the element (within selector, if given). Acts only on one exact match, else lists candidates.' };
const shot = { type: 'integer', minimum: 1, description: 'A screenshot number: x, y are then a point on that image.' };
/** One end of drag: an element or a point (and `extra`). The fields are as for click, so no descriptions. */
const dragEnd = (extra = {}) => ({
  type: 'object',
  properties: {
    ref: { type: 'integer', minimum: 1 }, selector: { type: 'string', minLength: 1, maxLength: 2000 },
    text: { type: 'string', minLength: 1, maxLength: 1000 }, x: { type: 'number' }, y: { type: 'number' }, ...extra,
  },
  additionalProperties: false,
});
const timeout = (def, max) => ({ type: 'integer', minimum: 100, maximum: max, description: `Milliseconds, default ${def}.` });

/** evaluate's `file`; mcpToolList puts the scripts directory's path where SCRIPTS_DIR is. */
export const SCRIPTS_DIR = '<scripts directory>';
const FILE_DESC = `Instead of expression: the name of a .js file in cctether's scripts directory, ${SCRIPTS_DIR}. Write a long script there once, then pass its name (edit it there and pass the name again); it runs like expression (a browser script: no import/export). Globals it defines stay in the page until it reloads.`;

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
    description: 'Load a URL in a tab, or go back / forward / reload. Waits for the page to load, then for wait_for if given.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', maxLength: 8192 },
        action: { type: 'string', enum: ['back', 'forward', 'reload'], description: 'Instead of url.' },
        tab,
        timeout_ms: timeout(30000, 120000),
        wait_for: {
          type: 'object',
          properties: { text: { type: 'string', minLength: 1, maxLength: 1000 }, selector },
          additionalProperties: false,
          description: 'Then wait (within timeout_ms) for this, as wait_for does, e.g. for content an app renders after loading.',
        },
      },
      additionalProperties: false,
    },
    annotations: ACT,
    timeoutMs: (a) => (a.timeout_ms ?? 30000) + 5000,
  },
  {
    name: 'read_page',
    title: 'Read page',
    description: 'Read the page, including same-origin iframes. mode "text" (default): visible text. "interactive": numbered list of links, buttons, inputs etc. — pass a number as `ref` to click/type/hover/select_option/scroll/screenshot. "html": HTML of `selector` (default body). Long output is split: pass the returned offset to continue.',
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
    description: 'Find elements by CSS selector and/or visible text, also inside same-origin iframes. Returns count, and for each: ref number, tag, text, key attributes, position, visibility.',
    inputSchema: {
      type: 'object',
      properties: {
        selector,
        text: { ...text, description: 'Visible text or aria-label (within selector, if given): exact matches first, then ones containing it.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 20.' },
        tab,
      },
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'screenshot',
    title: 'Screenshot',
    description: 'Screenshot the visible area (default), the full page, or one element (ref or selector). Each screenshot has a number for click/hover/scroll.',
    inputSchema: {
      type: 'object',
      properties: {
        full_page: { type: 'boolean', description: 'With ref/selector: the whole scrollable content of that element (e.g. an app\'s content pane).' },
        ref,
        selector,
        format: { type: 'string', enum: ['jpeg', 'png'], description: 'Default jpeg.' },
        quality: { type: 'integer', minimum: 1, maximum: 100, description: 'JPEG quality, default 75.' },
        tab,
      },
      additionalProperties: false,
    },
    annotations: READ,
    timeoutMs: (a) => (a.full_page && (a.ref != null || a.selector != null) ? 90000 : DEFAULT_TIMEOUT_MS),
  },
  {
    name: 'resize_viewport',
    title: 'Resize viewport',
    description: 'Resize a tab\'s viewport (CSS px) without resizing the browser window, e.g. width 390 to check a narrow layout. A desktop viewport, not mobile-device emulation. An omitted dimension keeps its current size. reset: true clears the override; it also ends when cctether detaches from the tab (5 min without tool calls, pause).',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'integer', minimum: 200, maximum: 3840 },
        height: { type: 'integer', minimum: 200, maximum: 3840 },
        reset: { type: 'boolean', description: 'Back to the real size.' },
        tab,
      },
      additionalProperties: false,
    },
    annotations: ACT,
  },
  {
    name: 'set_color_scheme',
    title: 'Set color scheme',
    description: 'Make a tab see a dark or light color scheme (the prefers-color-scheme media feature), e.g. to check a page\'s dark mode, without changing the browser\'s own setting. It does not operate a site\'s own theme switch or change a theme the site saved. "system" removes the override; it also ends when cctether detaches from the tab (5 min without tool calls, pause).',
    inputSchema: {
      type: 'object',
      properties: { scheme: { type: 'string', enum: ['dark', 'light', 'system'] }, tab },
      required: ['scheme'],
      additionalProperties: false,
    },
    annotations: ACT,
  },
  {
    name: 'click',
    title: 'Click',
    description: 'Click an element (ref, selector and/or text) or a point (x, y; with screenshot, a point on that image) with real mouse events. Scrolls the element into view first.',
    inputSchema: {
      type: 'object',
      properties: {
        ref, selector, text, x, y, screenshot: shot,
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
    description: 'Scroll an element into view (ref, selector and/or text), or scroll the page — or the scrollable element under (x, y) — in a direction.',
    inputSchema: {
      type: 'object',
      properties: {
        ref, selector, text,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', minimum: 1, maximum: 100000, description: 'Pixels, default 80% of the viewport.' },
        x, y, screenshot: shot,
        tab,
      },
      additionalProperties: false,
    },
    annotations: ACT,
  },
  {
    name: 'hover',
    title: 'Hover',
    description: 'Move the mouse over an element (ref, selector and/or text) or a point (x, y).',
    inputSchema: { type: 'object', properties: { ref, selector, text, x, y, screenshot: shot, tab }, additionalProperties: false },
    annotations: ACT,
  },
  {
    name: 'drag',
    title: 'Drag',
    description: 'Drag with the mouse: press on `from`, move to `to` in steps, release. For sortable lists, sliders, splitters, maps and HTML drag and drop. Both ends must be in view at once (scroll first, or resize_viewport). Check the result with a screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { ...dragEnd(), description: 'Where to press: an element (ref, selector and/or text, as for click) or a point (x, y: viewport CSS pixels, or on screenshot).' },
        to: {
          ...dragEnd({ dx: { type: 'number' }, dy: { type: 'number' } }),
          description: 'Where to release: an element, a point, or dx, dy: an offset in CSS pixels from the from point (e.g. for a slider). Measured once, before pressing.',
        },
        screenshot: { ...shot, description: 'A viewport screenshot number: x, y in from/to are then points on that image.' },
        steps: { type: 'integer', minimum: 1, maximum: 100, description: 'Mouse moves on the way. Default 10.' },
        hold_ms: { type: 'integer', minimum: 0, maximum: 5000, description: 'Hold the button this long before moving, for press-and-hold drags.' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] }, maxItems: 4 },
        tab,
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    annotations: ACT,
    timeoutMs: (a) => DEFAULT_TIMEOUT_MS + (a.hold_ms ?? 0),
  },
  {
    name: 'select_option',
    title: 'Select option',
    description: 'Choose option(s) in a <select>, matching each value against option value, then label. Also a custom dropdown that declares itself (role combobox or listbox): opens it and clicks the matching option (one value).',
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
    description: 'Wait until text appears on the page, or an element matching selector, or text inside such an element (selector + text). gone: true waits until it is not there. Says if it was there from the start.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 1000 },
        selector,
        gone: { type: 'boolean' },
        timeout_ms: timeout(10000, 600000),
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
    description: 'Run JavaScript in the page and return the result as JSON. Works like the DevTools console: the value of the last expression is returned (a Promise is awaited), top-level await is allowed. world "page" (default) shares globals with the page; "isolated" sees only the DOM. Pass `expression` or `file`.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', minLength: 1, maxLength: 200000 },
        file: { type: 'string', minLength: 1, maxLength: 1000, description: FILE_DESC },
        world: { type: 'string', enum: ['page', 'isolated'] },
        timeout_ms: timeout(10000, 120000),
        tab,
      },
      additionalProperties: false,
    },
    // Read by the service (mcp.js), which sends `expression` to the extension instead.
    serverOnly: ['file'],
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

/** Tool list as sent in MCP tools/list; `scriptsDir`: the path to put in evaluate's `file`. */
export function mcpToolList(scriptsDir = null) {
  return TOOLS.map(({ name, title, description, inputSchema, annotations }) => {
    let schema = inputSchema;
    if (inputSchema.properties.file) {
      const { file, ...props } = inputSchema.properties;
      // Without a scripts directory (the shim's fallback answers), there is no `file`.
      schema = scriptsDir
        ? { ...inputSchema, properties: { ...inputSchema.properties, file: { ...file, description: file.description.replace(SCRIPTS_DIR, scriptsDir) } } }
        : { ...inputSchema, properties: props };
    }
    return { name, title, description, inputSchema: schema, annotations: { title, ...annotations } };
  });
}

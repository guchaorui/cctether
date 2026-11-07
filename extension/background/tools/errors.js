// Error type for every expected tool failure. `code` is one of the codes listed in tools/index.js;
// `message` is English and says what happened and what Claude should do next.

export class ToolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

// Test fixture: a content script that logs, so console_messages can attribute it to this extension.
console.log('ext-logger content script ran on', location.pathname);
console.warn('ext-logger warning');

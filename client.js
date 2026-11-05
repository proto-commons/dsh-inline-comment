/**
 * Inline Comment — Client half.
 *
 * The overlay watches the document selection. When the selection lands inside
 * a conversation's message area, a small "annotate" pill floats next to it.
 * The note is composed in a popover and appended into that session's message
 * composer as one atomic reference chip (the same capsule the file/mention
 * references use). Hovering or clicking the chip previews the quoted text and
 * the note; the model receives the quote block when the message is sent.
 *
 * The composer lives in a session-scoped slot, so its `inputActions` and input
 * state are published into a small bridge registry that the frame-wide overlay
 * reads by session id. The chip source registers its serializer with the
 * client `inputTriggers` roster so a draft containing chips still sends.
 */
window.__ModuleLoader__.load({
  id: 'dsh-inline-comment',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useLayoutEffect, useRef, useState } = React;

    const NS = 'inline-comment';
    const CHIP_SOURCE = 'inline-comment';
    const MAX_QUOTE = 320;
    const MAX_COMMENT = 4000;

    const DICTS = {
      en: {
        pill: 'Annotate',
        chipLabel: 'Annotation',
        pillTitle: 'Annotate the selected text',
        pillAria: 'Add an annotation to the selected text',
        title: 'Add annotation',
        placeholder: 'What should change here? Add context, a correction, or a question…',
        hintEnter: '↵ add · Shift+↵ newline · Esc',
        hintMod: '{key} add · Esc',
        cancel: 'Cancel',
        submit: 'Add to message',
        added: 'Annotation added to the message box',
        unavailable: "The message box isn't accepting edits right now.",
        noteLabel: 'Annotation: ',
        close: 'Close',
        peekTitle: 'Annotation',
        peekHint: 'Backspace in the message box removes this annotation',
        peekHintSent: 'Sent as part of this message',
        settingsSubmitTitle: 'Comment shortcut',
        settingsSubmitDesc: 'Enter adds the comment; Shift+Enter inserts a line break. Switch to ⌘↵ if you prefer Enter only for line breaks.',
        settingsSubmitEnter: 'Enter',
        settingsSubmitMod: '⌘↵',
      },
      zh: {
        pill: '批注',
        chipLabel: '批注',
        pillTitle: '为选中内容添加批注',
        pillAria: '为选中的文字添加批注',
        title: '添加批注',
        placeholder: '这里要改什么？补充背景、提出修改或追问…',
        hintEnter: '回车添加 · Shift+回车换行 · Esc',
        hintMod: '{key} 添加 · Esc',
        cancel: '取消',
        submit: '添加到输入框',
        added: '批注已添加到输入框',
        unavailable: '输入框暂时不能编辑，请稍后再试。',
        noteLabel: '批注：',
        close: '关闭',
        peekTitle: '批注',
        peekHint: '在输入框里按退格键可删除这条批注',
        peekHintSent: '已随这条消息发出',
        settingsSubmitTitle: '批注快捷键',
        settingsSubmitDesc: '回车直接添加，Shift+回车换行；也可以改成 ⌘/Ctrl+回车添加。',
        settingsSubmitEnter: '回车',
        settingsSubmitMod: '⌘↵',
      },
    };

    /** sessionId -> { actions, getEndSpan } published by the session composer. */
    const bridges = new Map();

    /** The floating preview card for one composer chip. */
    const peekStore = { value: null, listeners: new Set() };
    let peekTimer = 0;

    let chipEnabled = false;

    const MOD_KEY =
      typeof navigator !== 'undefined' &&
      /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '')
        ? '⌘↵'
        : 'Ctrl+↵';

    /* ------------------------------------------------------- submit shortcut */

    const SUBMIT_PREF_KEY = 'dsh.inline-comment.submit-mode';

    const submitMode = { value: readSubmitMode(), listeners: new Set() };

    function readSubmitMode() {
      try {
        return window.localStorage.getItem(SUBMIT_PREF_KEY) === 'mod' ? 'mod' : 'enter';
      } catch (cause) {
        return 'enter';
      }
    }

    function writeSubmitMode(value) {
      const next = value === 'mod' ? 'mod' : 'enter';
      submitMode.value = next;
      try {
        window.localStorage.setItem(SUBMIT_PREF_KEY, next);
      } catch (cause) {
        /* storage may be unavailable; the in-memory preference still applies */
      }
      for (const listener of submitMode.listeners) {
        try {
          listener(next);
        } catch (cause) {
          /* a listener must never break the writer */
        }
      }
    }

    function useSubmitMode() {
      const [value, setValue] = useState(submitMode.value);
      useEffect(() => {
        const listener = (next) => setValue(next);
        submitMode.listeners.add(listener);
        setValue(submitMode.value);
        return () => {
          submitMode.listeners.delete(listener);
        };
      }, []);
      return value;
    }

    const CSS = `
.sa-root {
  position: fixed;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  z-index: 40;
  pointer-events: none;
}
.sa-pill {
  position: fixed;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px 0 8px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: 0.01em;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
  animation: sa-pop 140ms cubic-bezier(0.2, 0.8, 0.3, 1);
  transition: border-color 120ms ease, background-color 120ms ease, transform 120ms ease;
}
.sa-pill:hover {
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  transform: translateY(-1px);
}
.sa-pill:active { transform: translateY(0); }
.sa-pill svg { color: var(--dsw-alias-brand-primary); flex: none; }
.sa-pill:focus-visible,
.sa-btn:focus-visible,
.sa-close:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.sa-pop,
.sa-peek {
  position: fixed;
  box-sizing: border-box;
  width: min(360px, calc(100vw - 16px));
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  /* Opaque raised surface, matching the sent-message preview. A translucent
     overlay token made the same card look gray over the composer and white
     over the transcript. */
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18);
  pointer-events: auto;
}
.sa-pop { animation: sa-rise 150ms cubic-bezier(0.2, 0.8, 0.3, 1); }
.sa-peek {
  width: min(380px, calc(100vw - 16px));
  animation: sa-rise 120ms cubic-bezier(0.2, 0.8, 0.3, 1);
}
.sa-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}
.sa-head-icon { color: var(--dsw-alias-brand-primary); display: flex; flex: none; }
.sa-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.sa-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.sa-close:hover {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.sa-quote {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  max-height: 76px;
  overflow: hidden;
}
.sa-quote-wide { max-height: 112px; }
.sa-quote-bar {
  flex: none;
  width: 2px;
  border-radius: 2px;
  background: var(--dsw-alias-brand-primary);
}
.sa-quote-text {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.55;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.sa-quote-wide .sa-quote-text { -webkit-line-clamp: 5; }
.sa-field {
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  transition: border-color 120ms ease;
}
.sa-field:focus-within { border-color: var(--dsw-alias-brand-primary); }
.sa-input {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 66px;
  max-height: 180px;
  padding: 0;
  border: 0;
  outline: 0;
  resize: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
}
.sa-input::placeholder { color: var(--dsw-alias-label-secondary); }
.sa-error {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary);
}
.sa-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.sa-hint {
  min-width: 0;
  overflow: hidden;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.sa-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.sa-btn {
  height: 28px;
  padding: 0 12px;
  border-radius: 7px;
  border: 1px solid transparent;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  transition: background-color 120ms ease, opacity 120ms ease;
}
.sa-btn-ghost {
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  border-color: transparent;
}
.sa-btn-ghost:hover {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.sa-btn-primary {
  background: var(--dsw-alias-brand-primary);
  color: #ffffff;
}
.sa-btn-primary:hover { opacity: 0.9; }
.sa-btn:disabled { opacity: 0.4; cursor: default; }
.sa-peek-note {
  margin-top: 10px;
  max-height: 220px;
  overflow: auto;
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.sa-peek-hint {
  margin-top: 10px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary);
}
.sa-toast {
  position: fixed;
  left: 50%;
  top: 64px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(440px, calc(100vw - 32px));
  padding: 9px 14px 9px 11px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
  line-height: 1.35;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
  pointer-events: none;
  animation: sa-toast-in 180ms cubic-bezier(0.2, 0.8, 0.3, 1);
}
.sa-toast-icon { display: flex; flex: none; color: var(--dsw-alias-state-success-primary); }
/* Annotation chips reuse the composer's reference capsule; only the leading
   glyph changes, so the chip reads as a comment instead of a file. */
[data-composer-chip="inline-comment"] { cursor: pointer; }
[data-composer-chip="inline-comment"] > span > svg { display: none; }
[data-composer-chip="inline-comment"] > span::before {
  content: "\\201C";
  font-size: 15px;
  line-height: 1;
  color: var(--dsw-alias-state-business-primary);
  margin-right: 1px;
}
/* Sent user messages render an annotation block as this capsule. */
.sa-msg-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  max-width: 240px;
  padding: 0 4px;
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-state-business-primary);
  background: transparent;
  vertical-align: baseline;
  user-select: none;
  cursor: pointer;
}
.sa-msg-chip:hover { background: var(--dsw-alias-state-business-tertiary); }
.sa-msg-chip:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.sa-msg-chip svg { flex: none; align-self: center; }
.sa-msg-chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sa-setting {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.sa-setting-text { flex: 1; min-width: 0; }
.sa-setting-title {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 24px;
}
.sa-setting-desc {
  margin-top: 2px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.sa-seg {
  display: inline-flex;
  flex: none;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.sa-seg-btn {
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.sa-seg-btn:hover:not([aria-pressed="true"]) { color: var(--dsw-alias-label-primary); }
.sa-seg-btn[aria-pressed="true"] {
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
@keyframes sa-pop {
  from { opacity: 0; transform: scale(0.94); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes sa-rise {
  from { opacity: 0; transform: translateY(4px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes sa-toast-in {
  from { opacity: 0; transform: translate(-50%, -6px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
@media (prefers-reduced-motion: reduce) {
  .sa-pill, .sa-pop, .sa-peek, .sa-toast { animation: none; }
  .sa-pill { transition: none; }
}
`;

    /* ---------------------------------------------------------------- icons */

    function glyph(paths, size, stroke) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: stroke || 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        paths.map((d, index) => h('path', { key: index, d })),
      );
    }

    const AnnotationIcon = ({ size }) =>
      glyph(
        [
          'M3.1 3.3h9.8v6.5H7.9l-2.6 2.3v-2.3H3.1V3.3Z',
          'M5.6 5.7h4.8',
          'M5.6 7.5h3',
        ],
        size || 13,
      );

    const PenIcon = ({ size }) =>
      glyph(['M11.6 2.6l1.8 1.8-7.6 7.6-2.5.7.7-2.5 7.6-7.6Z', 'M10 4.2l1.8 1.8'], size || 13);

    const CloseIcon = ({ size }) =>
      glyph(['M4 4l8 8', 'M12 4l-8 8'], size || 12, 1.5);

    const CheckIcon = ({ size }) =>
      glyph(['M3.2 8.4l3.1 3.1 6.5-6.9'], size || 14, 1.8);

    /* -------------------------------------------------------------- helpers */

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), Math.max(min, max));
    }

    function elementOf(node) {
      if (!node) return null;
      return node.nodeType === 1 ? node : node.parentElement || null;
    }

    function normalizeText(value) {
      return String(value == null ? '' : value)
        .replace(/\u00a0/g, ' ')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .trim();
    }

    function clip(value, max) {
      if (value.length <= max) return value;
      const slice = value.slice(0, max);
      const cut = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'));
      const head = cut > max * 0.6 ? slice.slice(0, cut) : slice;
      return head.replace(/[\s,;，；。.、:：\-—]+$/u, '') + '…';
    }

    function escapeAttribute(value) {
      return String(value).replace(/["\\]/g, '\\$&');
    }

    /** Base64url of the UTF-8 JSON payload; self-contained so drafts survive reloads. */
    function encodeAnnotation(payload) {
      try {
        const bytes = new TextEncoder().encode(JSON.stringify(payload));
        let binary = '';
        const chunk = 0x8000;
        for (let index = 0; index < bytes.length; index += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
        }
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
      } catch (cause) {
        console.error('[inline-comment] encode failed', cause);
        return '';
      }
    }

    function decodeAnnotation(ref) {
      try {
        const encoded = String(ref || '');
        if (!encoded) return null;
        let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
        const padding = base64.length % 4;
        if (padding !== 0) base64 += '='.repeat(4 - padding);
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        if (!parsed || typeof parsed.q !== 'string' || typeof parsed.c !== 'string') return null;
        return {
          v: 1,
          q: parsed.q,
          c: parsed.c,
          n: typeof parsed.n === 'string' ? parsed.n : '',
          l: parsed.l === true,
        };
      } catch (cause) {
        return null;
      }
    }

    /** The model-facing form of one annotation: a quote block. */
    function annotationText(payload) {
      const lines = clip(normalizeText(payload.q), MAX_QUOTE)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 5);
      const quoted = (lines.length > 0 ? lines : ['…']).map((line) => `> ${line}`).join('\n');
      const notes = normalizeText(payload.c)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const block = `${quoted}\n> \n> ${payload.n || ''}${notes.join('\n> ')}`;
      return `${payload.l ? '\n\n' : ''}${block}\n\n`;
    }

    /* --------------------------------------------- sent-message annotation chip */

    const USER_TEXT_RULE = 'inline-comment';
    const NOTE_LABELS = [DICTS.zh.noteLabel, DICTS.en.noteLabel];

    /**
     * Parse the quote block this plugin serializes:
     *   > quote line
     *   >
     *   > 批注：comment
     * Returns the quote and comment, or undefined for an ordinary blockquote.
     */
    function parseAnnotationBlock(lines) {
      const bodies = lines.map((line) => line.replace(/^>[ \t]?/, ''));
      for (let index = 2; index < bodies.length; index += 1) {
        if (bodies[index - 1].trim() !== '') continue;
        const line = bodies[index];
        const label = NOTE_LABELS.find((candidate) => line.startsWith(candidate));
        if (!label) continue;
        const quote = bodies.slice(0, index - 1).join('\n').trim();
        const comment = [line.slice(label.length), ...bodies.slice(index + 1)].join('\n').trim();
        if (quote && comment) return { q: quote, c: comment };
      }
      return undefined;
    }

    function matchAnnotationText(text, from) {
      let index = from;
      while (index < text.length) {
        if (index !== 0 && text[index - 1] !== '\n') {
          const next = text.indexOf('\n', index);
          if (next === -1) return undefined;
          index = next + 1;
          continue;
        }
        if (text[index] !== '>') {
          const next = text.indexOf('\n', index);
          if (next === -1) return undefined;
          index = next + 1;
          continue;
        }
        const lines = [];
        let cursor = index;
        while (cursor < text.length && text[cursor] === '>') {
          const next = text.indexOf('\n', cursor);
          const lineEnd = next === -1 ? text.length : next;
          lines.push(text.slice(cursor, lineEnd));
          cursor = next === -1 ? text.length : next + 1;
        }
        const parsed = parseAnnotationBlock(lines);
        if (parsed) {
          let end = cursor;
          if (end > index && text[end - 1] === '\n') end -= 1;
          return { id: USER_TEXT_RULE, start: index, end, data: parsed };
        }
        index = cursor;
      }
      return undefined;
    }

    function annotationTextRule() {
      return {
        id: USER_TEXT_RULE,
        order: 35,
        match(text, from) {
          return matchAnnotationText(text, from);
        },
      };
    }

    /** Render one sent annotation as the same capsule the composer chip uses. */
    function MessageAnnotationChip(props) {
      const node = props.node;
      const data = node && node.data;
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const chipRef = useRef(null);
      const summary =
        data && typeof data.c === 'string'
          ? clip(normalizeText(data.c).split('\n')[0] || '', 22)
          : '';
      if (!data || typeof data.q !== 'string' || typeof data.c !== 'string') {
        return h('span', null, props.raw || '');
      }
      const reference = `message:${node.start}`;
      const payload = { v: 1, q: data.q, c: data.c, n: '', l: false };
      const show = () => {
        const element = chipRef.current;
        if (!element) return;
        const rect = element.getBoundingClientRect();
        if (rect.width < 1) return;
        cancelPeekHide();
        /* Two messages may both start at offset 0: publish unconditionally so the
           card always belongs to the chip under the pointer. */
        publishPeek({ sessionId: props.sessionId, ref: reference, payload, rect, origin: 'message' });
      };
      return h(
        'span',
        {
          ref: chipRef,
          className: 'sa-msg-chip',
          'data-inline-comment-chip': '',
          role: 'button',
          tabIndex: 0,
          'aria-label': summary ? `${t('chipLabel')}：${summary}` : t('chipLabel'),
          onMouseEnter: show,
          onMouseLeave: () => schedulePeekHide(),
          onClick: show,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              show();
            }
          },
        },
        h(AnnotationIcon, { size: 12 }),
        h(
          'span',
          { className: 'sa-msg-chip-label' },
          summary || t('chipLabel'),
        ),
      );
    }

    /** General-settings row for the popover's submit shortcut. */
    function SubmitKeyRow(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const mode = useSubmitMode();
      return h(
        'div',
        { className: 'sa-setting' },
        h(
          'div',
          { className: 'sa-setting-text' },
          h('div', { className: 'sa-setting-title' }, t('settingsSubmitTitle')),
          h('div', { className: 'sa-setting-desc' }, t('settingsSubmitDesc')),
        ),
        h(
          'div',
          { className: 'sa-seg', role: 'group', 'aria-label': t('settingsSubmitTitle') },
          h(
            'button',
            {
              type: 'button',
              className: 'sa-seg-btn',
              'aria-pressed': mode === 'enter',
              onClick: () => writeSubmitMode('enter'),
            },
            t('settingsSubmitEnter'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'sa-seg-btn',
              'aria-pressed': mode === 'mod',
              onClick: () => writeSubmitMode('mod'),
            },
            t('settingsSubmitMod'),
          ),
        ),
      );
    }

    /** Plain-text fallback used when the chip route is unavailable. */
    function buildInsertion(quote, comment, start, t) {
      const lines = clip(normalizeText(quote), MAX_QUOTE)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 5);
      const quoted = (lines.length > 0 ? lines : ['…']).map((line) => `> ${line}`).join('\n');
      const notes = normalizeText(comment)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const block = `${quoted}\n> \n> ${t('noteLabel')}${notes.join('\n> ')}`;
      return start > 0 ? `\n\n${block}` : block;
    }

    function isEditable(node) {
      const element = elementOf(node);
      if (!element || !element.closest) return false;
      return Boolean(
        element.closest(
          'input, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"]',
        ),
      );
    }

    /** The conversation message area that owns this node, if any. */
    function conversationScope(node) {
      const element = elementOf(node);
      if (!element || !element.closest) return null;
      if (element.closest('[data-conversation-region="composer"]')) return null;
      if (element.closest('iframe, .xterm, [data-approval-key], [inert]')) return null;
      const scroll = element.closest('[data-conversation-scroll]');
      if (!scroll) return null;
      const host = scroll.closest('[data-conversation-session]');
      if (!host) return null;
      const sessionId = host.getAttribute('data-conversation-session');
      return sessionId ? { sessionId } : null;
    }

    /** Read the live selection when it is a usable conversation quote. */
    function readSelection(root) {
      const selection = typeof window !== 'undefined' ? window.getSelection() : null;
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      const text = normalizeText(selection.toString());
      if (text.length < 2) return null;
      const anchor = range.commonAncestorContainer;
      if (root && root.contains(anchor)) return null;
      if (isEditable(anchor)) return null;
      const scope = conversationScope(anchor);
      if (!scope) return null;
      const rects = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 1 && rect.height > 1,
      );
      if (rects.length === 0) return null;
      const bounds = rects.reduce(
        (acc, rect) => ({
          left: Math.min(acc.left, rect.left),
          top: Math.min(acc.top, rect.top),
          right: Math.max(acc.right, rect.right),
          bottom: Math.max(acc.bottom, rect.bottom),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
      );
      if (bounds.bottom < 0 || bounds.top > window.innerHeight) return null;
      return {
        text,
        sessionId: scope.sessionId,
        bounds,
        last: rects[rects.length - 1],
      };
    }

    /** Small pill next to the end of the selection, flipping when the viewport is tight. */
    function placePill(anchor) {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const SIZE_W = 78;
      const SIZE_H = 28;
      const GAP = 8;
      const right = anchor.last.right + GAP;
      if (right + SIZE_W <= width - 8) {
        return {
          left: right,
          top: clamp(anchor.last.top + (anchor.last.height - SIZE_H) / 2, 8, height - SIZE_H - 8),
        };
      }
      const above = anchor.bounds.top - SIZE_H - GAP;
      if (above >= 8) {
        return { left: clamp(anchor.bounds.left, 8, width - SIZE_W - 8), top: above };
      }
      return {
        left: clamp(anchor.bounds.left, 8, width - SIZE_W - 8),
        top: clamp(anchor.bounds.bottom + GAP, 8, height - SIZE_H - 8),
      };
    }

    /** Keep a floating card beside the quote, above it by default. */
    function placePopover(anchor, popWidth, popHeight) {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const margin = 8;
      let top = anchor.bounds.top - popHeight - 12;
      if (top < margin) top = anchor.bounds.bottom + 12;
      top = clamp(top, margin, height - popHeight - margin);
      const left = clamp(
        (anchor.bounds.left + anchor.bounds.right) / 2 - popWidth / 2,
        margin,
        width - popWidth - margin,
      );
      return { left, top };
    }

    function composerSeat(sessionId) {
      try {
        const host = document.querySelector(
          `[data-conversation-session="${escapeAttribute(sessionId)}"]`,
        );
        if (!host) return null;
        return host.querySelector('[data-conversation-region="composer"]');
      } catch (cause) {
        return null;
      }
    }

    function composerRect(sessionId) {
      const seat = composerSeat(sessionId);
      if (seat) {
        const rect = seat.getBoundingClientRect();
        if (rect.width > 1) return rect;
      }
      const width = Math.min(360, window.innerWidth - 16);
      const left = (window.innerWidth - width) / 2;
      const top = window.innerHeight - 160;
      return {
        left,
        right: left + width,
        top,
        bottom: top + 80,
        width,
        height: 80,
      };
    }

    /** Put the caret at the end of the composer that just received the chip. */
    function focusComposerEnd(sessionId) {
      const seat = composerSeat(sessionId);
      if (!seat) return;
      const editor = seat.querySelector('[contenteditable="true"], [contenteditable=""]');
      if (!editor) return;
      try {
        editor.focus({ preventScroll: true });
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        if (!selection) return;
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (cause) {
        /* caret placement is a convenience, never a failure */
      }
    }

    /* ------------------------------------------------------------ peek store */

    function publishPeek(next) {
      peekStore.value = next;
      for (const listener of peekStore.listeners) {
        try {
          listener(next);
        } catch (cause) {
          /* a listener must never break the publisher */
        }
      }
    }

    function schedulePeekHide(delay) {
      window.clearTimeout(peekTimer);
      peekTimer = window.setTimeout(() => publishPeek(null), delay == null ? 220 : delay);
    }

    function cancelPeekHide() {
      window.clearTimeout(peekTimer);
    }

    /* --------------------------------------------------------- chip insertion */

    /** End of the draft in detect coordinates (chips are one detect char each). */
    function endSpanOf(state) {
      if (!state) return null;
      let end = typeof state.draft === 'string' ? state.draft.length : 0;
      const occurrences = state.occurrences || [];
      for (const occurrence of occurrences) {
        end -= Math.max(0, (typeof occurrence.length === 'number' ? occurrence.length : 1) - 1);
      }
      if (state.claim && typeof state.claim.token === 'string') {
        end -= Math.max(0, state.claim.token.trimEnd().length - 1);
      }
      if (!Number.isFinite(end) || end < 0) return null;
      return { start: end, end, draftRev: state.draftRev };
    }

    function annotationSource() {
      return {
        trigger: '\u0001',
        name: CHIP_SOURCE,
        order: 500,
        showGroupTitle: false,
        candidates: () => [],
        openReference(session, reference) {
          const ref = reference && reference.ref;
          const payload = decodeAnnotation(ref);
          if (!payload || !session || !session.sessionId) return false;
          const current = peekStore.value;
          if (current && current.ref === ref) {
            cancelPeekHide();
            return true;
          }
          publishPeek({
            sessionId: session.sessionId,
            ref,
            payload,
            rect: composerRect(session.sessionId),
            origin: 'composer',
          });
          return true;
        },
        codec: {
          clipboardText: () => `[${CHIP_SOURCE}]`,
          serialize: (ref) => {
            const payload = decodeAnnotation(ref);
            if (!payload) {
              return Promise.reject(new Error('inline-comment: unreadable annotation'));
            }
            return Promise.resolve(annotationText(payload));
          },
        },
      };
    }

    /* ----------------------------------------------------------- components */

    function InputBridge(props) {
      if (
        !props ||
        !props.sessionId ||
        !props.inputActions ||
        typeof props.useInput !== 'function'
      ) {
        return null;
      }
      return h(InputBridgeBody, props);
    }

    function InputBridgeBody(props) {
      const sessionId = props.sessionId;
      const inputActions = props.inputActions;
      const draft = props.useInput((state) => state.draft);
      const occurrences = props.useInput((state) => state.occurrences);
      const claim = props.useInput((state) => state.claim);
      const draftRev = props.useInput((state) => state.draftRev);

      const stateRef = useRef(null);
      stateRef.current = { draft, occurrences, claim, draftRev };
      const anchorRef = useRef(null);

      useEffect(() => {
        if (!sessionId || !inputActions) return undefined;
        const entry = {
          actions: inputActions,
          getEndSpan: () => endSpanOf(stateRef.current),
        };
        bridges.set(sessionId, entry);
        return () => {
          if (bridges.get(sessionId) === entry) bridges.delete(sessionId);
        };
      }, [sessionId, inputActions]);

      /* Hover a chip to preview it; clicks route through the source codec. */
      useEffect(() => {
        const anchor = anchorRef.current;
        if (!anchor || !anchor.closest) return undefined;
        const seat = anchor.closest('[data-conversation-region="composer"]');
        if (!seat) return undefined;
        const onOver = (event) => {
          const target = event.target;
          if (!target || !target.closest) return;
          const chip = target.closest('[data-composer-chip="inline-comment"]');
          if (!chip || !seat.contains(chip)) return;
          if (event.relatedTarget instanceof Node && chip.contains(event.relatedTarget)) return;
          /* The host labels the chip with a native title; our card replaces it. */
          for (const titled of chip.querySelectorAll('[title]')) titled.removeAttribute('title');
          const chips = Array.from(seat.querySelectorAll('[data-composer-chip]'));
          const index = chips.indexOf(chip);
          const occurrence = stateRef.current && stateRef.current.occurrences
            ? stateRef.current.occurrences[index]
            : null;
          if (!occurrence || occurrence.source !== CHIP_SOURCE) return;
          const payload = decodeAnnotation(occurrence.ref);
          if (!payload) return;
          const rect = chip.getBoundingClientRect();
          if (rect.width < 1) return;
          cancelPeekHide();
          const current = peekStore.value;
          if (current && current.ref === occurrence.ref) return;
          publishPeek({ sessionId, ref: occurrence.ref, payload, rect, origin: 'composer' });
        };
        const onOut = (event) => {
          const target = event.target;
          if (!target || !target.closest) return;
          const chip = target.closest('[data-composer-chip="inline-comment"]');
          if (!chip) return;
          if (event.relatedTarget instanceof Node && chip.contains(event.relatedTarget)) return;
          schedulePeekHide();
        };
        seat.addEventListener('mouseover', onOver);
        seat.addEventListener('mouseout', onOut);
        return () => {
          seat.removeEventListener('mouseover', onOver);
          seat.removeEventListener('mouseout', onOut);
        };
      }, [sessionId]);

      /* A removed chip must take its preview with it. */
      useEffect(() => {
        const current = peekStore.value;
        if (!current || current.origin !== 'composer' || current.sessionId !== sessionId) return;
        const list = occurrences || [];
        if (!list.some((occurrence) => occurrence.ref === current.ref)) publishPeek(null);
      }, [occurrences, sessionId]);

      return h('span', { ref: anchorRef, style: { display: 'none' }, 'aria-hidden': 'true' });
    }

    /* ------------------------------------------------------------- the apply */

    return {
      inject: ['slots', 'locale', 'sessions', 'uiConversation'],
      apply(ctx) {
        peekStore.value = null;
        window.clearTimeout(peekTimer);
        ctx.effect(() => ctx.locale.register(NS, DICTS), 'inline-comment: dictionaries');
        ctx.effect(
          () => ctx.uiConversation.userText.register(annotationTextRule()),
          'inline-comment: sent-message rule',
        );

        ctx.inject(['inputTriggers'], (scope) => {
          const inputTriggers = scope.inputTriggers;
          if (!inputTriggers) return;
          scope.effect(() => {
            let dispose;
            try {
              dispose = inputTriggers.registerSource(annotationSource());
              chipEnabled = true;
            } catch (cause) {
              chipEnabled = false;
              console.error('[inline-comment] chip source unavailable', cause);
              return () => {
                chipEnabled = false;
              };
            }
            return () => {
              chipEnabled = false;
              if (typeof dispose === 'function') dispose();
            };
          }, 'inline-comment: composer chip source');
        });

        function useT() {
          const [, force] = useState(0);
          useEffect(
            () =>
              ctx.locale.subscribe(() => {
                force((value) => value + 1);
              }),
            [],
          );
          return ctx.locale.bind(NS);
        }

        function usePeek() {
          const [value, setValue] = useState(peekStore.value);
          useEffect(() => {
            const listener = (next) => setValue(next);
            peekStore.listeners.add(listener);
            setValue(peekStore.value);
            return () => {
              peekStore.listeners.delete(listener);
            };
          }, []);
          return value;
        }

        function Annotator() {
          const t = useT();
          const submitModeValue = useSubmitMode();
          const [info, setInfo] = useState(null);
          const [pill, setPill] = useState(null);
          const [phase, setPhase] = useState('idle');
          const [comment, setComment] = useState('');
          const [error, setError] = useState('');
          const [popPos, setPopPos] = useState(null);
          const [toast, setToast] = useState(null);

          const rootRef = useRef(null);
          const popRef = useRef(null);
          const inputRef = useRef(null);
          const phaseRef = useRef('idle');
          const infoRef = useRef(null);
          const commentRef = useRef('');

          phaseRef.current = phase;
          infoRef.current = info;
          commentRef.current = comment;

          const notify = useCallback((kind, text) => {
            setToast({ id: Date.now(), kind, text });
          }, []);

          const close = useCallback(() => {
            setPhase('idle');
            setComment('');
            setError('');
            setPopPos(null);
            setInfo(null);
            setPill(null);
          }, []);

          const open = useCallback(() => {
            if (!infoRef.current) return;
            publishPeek(null);
            setComment('');
            setError('');
            setPopPos(null);
            setPill(null);
            setPhase('compose');
          }, []);

          /* Track the document selection while idle. */
          useEffect(() => {
            let timer = 0;
            let dragging = false;
            const evaluate = () => {
              if (phaseRef.current === 'compose' || dragging) return;
              const next = readSelection(rootRef.current);
              if (!next || !bridges.has(next.sessionId)) {
                setInfo(null);
                setPill(null);
                return;
              }
              setInfo(next);
              setPill(placePill(next));
            };
            const schedule = () => {
              window.clearTimeout(timer);
              timer = window.setTimeout(evaluate, 110);
            };
            const onPointerDown = (event) => {
              const root = rootRef.current;
              if (root && event.target instanceof Node && root.contains(event.target)) return;
              dragging = true;
              if (phaseRef.current === 'compose') {
                if (commentRef.current.trim() === '') close();
                return;
              }
              setPill(null);
              /* Clicking an annotation chip keeps (or opens) its preview; the
                 click itself routes through the source's openReference. */
              const target = event.target;
              const chip =
                target && target.closest
                  ? target.closest('[data-composer-chip="inline-comment"], [data-inline-comment-chip]')
                  : null;
              if (!chip) publishPeek(null);
            };
            const onPointerUp = () => {
              dragging = false;
              if (phaseRef.current !== 'compose') schedule();
            };
            /* Keep the popover glued to its quote while the page scrolls. */
            const reposition = () => {
              const anchor = infoRef.current;
              if (!anchor) return;
              const selection = window.getSelection();
              if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
              const rects = Array.from(selection.getRangeAt(0).getClientRects()).filter(
                (rect) => rect.width > 1 && rect.height > 1,
              );
              if (rects.length === 0) return;
              const bounds = rects.reduce(
                (acc, rect) => ({
                  left: Math.min(acc.left, rect.left),
                  top: Math.min(acc.top, rect.top),
                  right: Math.max(acc.right, rect.right),
                  bottom: Math.max(acc.bottom, rect.bottom),
                }),
                { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
              );
              const next = { ...anchor, bounds, last: rects[rects.length - 1] };
              infoRef.current = next;
              setInfo(next);
              const pop = popRef.current;
              if (pop) {
                const rect = pop.getBoundingClientRect();
                setPopPos(placePopover(next, rect.width, rect.height));
              }
            };
            const onScroll = (event) => {
              const root = rootRef.current;
              if (root && event.target instanceof Node && root.contains(event.target)) return;
              if (phaseRef.current === 'compose') {
                reposition();
                return;
              }
              setPill(null);
              publishPeek(null);
            };
            const onKeyDown = (event) => {
              if (event.key !== 'Escape') return;
              if (phaseRef.current !== 'compose' && !peekStore.value) return;
              event.preventDefault();
              event.stopPropagation();
              publishPeek(null);
              if (phaseRef.current === 'compose') close();
            };
            const releaseDrag = () => {
              dragging = false;
            };
            document.addEventListener('selectionchange', schedule);
            document.addEventListener('pointerdown', onPointerDown, true);
            document.addEventListener('pointerup', onPointerUp, true);
            document.addEventListener('keydown', onKeyDown, true);
            window.addEventListener('scroll', onScroll, true);
            window.addEventListener('resize', onScroll);
            window.addEventListener('blur', releaseDrag);
            return () => {
              window.clearTimeout(timer);
              document.removeEventListener('selectionchange', schedule);
              document.removeEventListener('pointerdown', onPointerDown, true);
              document.removeEventListener('pointerup', onPointerUp, true);
              document.removeEventListener('keydown', onKeyDown, true);
              window.removeEventListener('scroll', onScroll, true);
              window.removeEventListener('resize', onScroll);
              window.removeEventListener('blur', releaseDrag);
            };
          }, [close]);

          /* Measure the popover and place it beside the quote. */
          useLayoutEffect(() => {
            if (phase !== 'compose') return undefined;
            const element = popRef.current;
            if (!element) return undefined;
            const place = () => {
              const anchor = infoRef.current;
              if (!anchor) return;
              const rect = element.getBoundingClientRect();
              setPopPos(placePopover(anchor, rect.width, rect.height));
            };
            place();
            let observer = null;
            if (typeof ResizeObserver === 'function') {
              observer = new ResizeObserver(place);
              observer.observe(element);
            }
            return () => {
              if (observer) observer.disconnect();
            };
          }, [phase]);

          /* Focus the note field as soon as the popover opens. */
          useEffect(() => {
            if (phase !== 'compose') return undefined;
            const frame = requestAnimationFrame(() => {
              if (inputRef.current) inputRef.current.focus({ preventScroll: true });
            });
            return () => cancelAnimationFrame(frame);
          }, [phase]);

          /* Retire the confirmation toast. */
          useEffect(() => {
            if (!toast) return undefined;
            const timer = window.setTimeout(() => setToast(null), 2800);
            return () => window.clearTimeout(timer);
          }, [toast]);

          const submit = () => {
            const anchor = infoRef.current;
            const value = comment.trim();
            if (!anchor || !value) return;
            const bridge = bridges.get(anchor.sessionId);
            const actions = bridge && bridge.actions;
            if (!actions) {
              setError(t('unavailable'));
              return;
            }

            const payload = {
              v: 1,
              q: clip(normalizeText(anchor.text), MAX_QUOTE),
              c: value.slice(0, MAX_COMMENT),
              n: t('noteLabel'),
              l: false,
            };
            let inserted = false;

            /* Preferred route: one atomic reference chip in the composer. */
            if (chipEnabled) {
              let scoped = null;
              try {
                scoped = ctx.sessions ? ctx.sessions.scope(anchor.sessionId) : undefined;
              } catch (cause) {
                scoped = undefined;
              }
              const span = bridge.getEndSpan ? bridge.getEndSpan() : null;
              if (scoped && span && typeof scoped.bail === 'function') {
                payload.l = span.start > 0;
                const ref = encodeAnnotation(payload);
                if (ref) {
                  const summary = clip(
                    normalizeText(value).split('\n').map((line) => line.trim()).filter(Boolean)[0] || '',
                    22,
                  );
                  const reference = {
                    source: CHIP_SOURCE,
                    ref,
                    label: summary || t('chipLabel'),
                    appearance: 'file',
                    clipboardText: `[${t('chipLabel')}]`,
                  };
                  try {
                    inserted =
                      scoped.bail(scoped, 'slash/input-insert-reference', {
                        reference,
                        span,
                      }) === true;
                  } catch (cause) {
                    console.error('[inline-comment] chip insert failed', cause);
                    inserted = false;
                  }
                }
              }
            }

            /* Fallback: plain quote block at the end of the draft. */
            if (!inserted) {
              let span = (bridge.getEndSpan && bridge.getEndSpan()) || null;
              if (!span) {
                try {
                  span = actions.captureInsertion();
                } catch (cause) {
                  span = null;
                }
              }
              if (!span) {
                setError(t('unavailable'));
                return;
              }
              const text = buildInsertion(anchor.text, value, span.start, t);
              try {
                inserted = actions.insertText(text, span) === true;
              } catch (cause) {
                console.error('[inline-comment] insert failed', cause);
                inserted = false;
              }
              if (!inserted) {
                try {
                  const fresh = actions.captureInsertion();
                  inserted = actions.insertText(buildInsertion(anchor.text, value, fresh.start, t), fresh) === true;
                } catch (cause) {
                  inserted = false;
                }
              }
            }

            if (!inserted) {
              setError(t('unavailable'));
              return;
            }

            close();
            publishPeek(null);
            try {
              const selection = window.getSelection();
              if (selection) selection.removeAllRanges();
            } catch (cause) {
              /* selection cleanup is best effort */
            }
            requestAnimationFrame(() => focusComposerEnd(anchor.sessionId));
            notify('success', t('added'));
          };

          const canSubmit = comment.trim().length > 0;
          const quotePreview = info ? clip(normalizeText(info.text), 400) : '';
          const peek = usePeek();
          const peekRef = useRef(null);
          const [peekPos, setPeekPos] = useState(null);

          useLayoutEffect(() => {
            if (!peek) {
              setPeekPos(null);
              return undefined;
            }
            const element = peekRef.current;
            if (!element) return undefined;
            const rect = element.getBoundingClientRect();
            setPeekPos(placePopover({ bounds: peek.rect }, rect.width, rect.height));
            return undefined;
          }, [peek]);

          const peekNode = peek
            ? h(
                'div',
                {
                  ref: peekRef,
                  className: 'sa-peek',
                  role: 'dialog',
                  'aria-label': t('peekTitle'),
                  style: {
                    left: peekPos ? peekPos.left : -9999,
                    top: peekPos ? peekPos.top : -9999,
                    visibility: peekPos ? 'visible' : 'hidden',
                  },
                  onMouseEnter: cancelPeekHide,
                  onMouseLeave: () => schedulePeekHide(),
                },
                h(
                  'div',
                  { className: 'sa-head' },
                  h('span', { className: 'sa-head-icon' }, h(AnnotationIcon, { size: 13 })),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'sa-close',
                      onClick: () => publishPeek(null),
                      title: t('close'),
                      'aria-label': t('close'),
                    },
                    h(CloseIcon, { size: 12 }),
                  ),
                ),
                h(
                  'div',
                  { className: 'sa-quote sa-quote-wide' },
                  h('div', { className: 'sa-quote-bar' }),
                  h('div', { className: 'sa-quote-text' }, peek.payload.q),
                ),
                h('div', { className: 'sa-peek-note' }, peek.payload.c),
                h(
                  'div',
                  { className: 'sa-peek-hint' },
                  peek.origin === 'message' ? t('peekHintSent') : t('peekHint'),
                ),
              )
            : null;

          const pillNode = pill
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'sa-pill',
                  style: { left: pill.left, top: pill.top },
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: open,
                  title: t('pillTitle'),
                  'aria-label': t('pillAria'),
                },
                h(AnnotationIcon, { size: 13 }),
                h('span', null, t('pill')),
              )
            : null;

          const popNode =
            phase === 'compose' && info
              ? h(
                  'div',
                  {
                    ref: popRef,
                    className: 'sa-pop',
                    role: 'dialog',
                    'aria-label': t('title'),
                    style: {
                      left: popPos ? popPos.left : -9999,
                      top: popPos ? popPos.top : -9999,
                      visibility: popPos ? 'visible' : 'hidden',
                    },
                  },
                  h(
                    'div',
                    { className: 'sa-head' },
                    h('span', { className: 'sa-head-icon' }, h(PenIcon, { size: 13 })),
                    h('div', { className: 'sa-title' }, t('title')),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'sa-close',
                        onClick: close,
                        title: t('close'),
                        'aria-label': t('close'),
                      },
                      h(CloseIcon, { size: 12 }),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'sa-quote' },
                    h('div', { className: 'sa-quote-bar' }),
                    h('div', { className: 'sa-quote-text' }, quotePreview),
                  ),
                  h(
                    'div',
                    { className: 'sa-field' },
                    h('textarea', {
                      ref: inputRef,
                      className: 'sa-input',
                      value: comment,
                      rows: 3,
                      maxLength: MAX_COMMENT,
                      placeholder: t('placeholder'),
                      'aria-label': t('placeholder'),
                      spellCheck: false,
                      onChange: (event) => {
                        setComment(event.target.value);
                        if (error) setError('');
                      },
                      onKeyDown: (event) => {
                        if (event.key !== 'Enter') return;
                        const native = event.nativeEvent;
                        if (native && (native.isComposing || native.keyCode === 229)) return;
                        if (event.metaKey || event.ctrlKey) {
                          event.preventDefault();
                          submit();
                          return;
                        }
                        if (submitModeValue === 'enter' && !event.shiftKey) {
                          event.preventDefault();
                          submit();
                        }
                      },
                    }),
                  ),
                  error ? h('div', { className: 'sa-error', role: 'alert' }, error) : null,
                  h(
                    'div',
                    { className: 'sa-foot' },
                    h(
                      'span',
                      { className: 'sa-hint' },
                      submitModeValue === 'mod' ? t('hintMod', { key: MOD_KEY }) : t('hintEnter'),
                    ),
                    h(
                      'div',
                      { className: 'sa-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'sa-btn sa-btn-ghost',
                          onClick: close,
                        },
                        t('cancel'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'sa-btn sa-btn-primary',
                          onClick: submit,
                          disabled: !canSubmit,
                        },
                        t('submit'),
                      ),
                    ),
                  ),
                )
              : null;

          const toastNode = toast
            ? h(
                'div',
                {
                  className: 'sa-toast',
                  role: 'status',
                  'aria-live': 'polite',
                  'data-kind': toast.kind,
                },
                h('span', { className: 'sa-toast-icon' }, h(CheckIcon, { size: 14 })),
                h('span', null, toast.text),
              )
            : null;

          return h(
            'div',
            { ref: rootRef, className: 'sa-root' },
            h('style', { key: 'inline-comment-css' }, CSS),
            peekNode,
            pillNode,
            popNode,
            toastNode,
          );
        }

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'inline-comment', order: 40 },
            Annotator,
          ),
        );
        ctx.slots.inject('conversation.input.overlay', () =>
          ctx.slots.register(
            { name: 'conversation.input.overlay', id: 'inline-comment-bridge', order: 95 },
            InputBridge,
          ),
        );
        ctx.slots.inject('conversation.user.text.node', () =>
          ctx.slots.register(
            {
              name: 'conversation.user.text.node',
              key: USER_TEXT_RULE,
              priority: 100,
              locale: NS,
            },
            MessageAnnotationChip,
          ),
        );
        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            {
              name: 'settings.general.item',
              id: 'inline-comment-submit',
              order: 21,
              locale: NS,
            },
            SubmitKeyRow,
          ),
        );
      },
    };
  },
});

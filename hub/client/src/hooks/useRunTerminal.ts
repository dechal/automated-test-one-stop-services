import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

/**
 * Stable imperative handle to the run terminal. Methods are safe to call before
 * the terminal has mounted (they no-op), so callers don't need to null-check.
 */
export interface RunTerminal {
  writeln: (line: string) => void;
  write: (chunk: string) => void;
  clear: () => void;
  fit: () => void;
  findNext: (term: string) => void;
  findPrevious: (term: string) => void;
  clearSearch: () => void;
  /** True once the underlying xterm instance is mounted and ready. */
  ready: () => boolean;
}

interface UseRunTerminalOptions {
  /** Whether this session's terminal is the visible tab (re-fit on show). */
  visible: boolean;
  /** Any value that, when it changes, should trigger a re-fit (e.g. run status). */
  refitKey: unknown;
  /** xterm font size in px; the persisted preference is the only source. */
  fontSize: number;
}

/**
 * Owns the xterm.js lifecycle for one run session: creation, addon wiring,
 * resize/visibility re-fit, and disposal. Extracted from RunSession so the
 * component orchestrates state while the imperative terminal plumbing lives
 * in one testable, self-contained place.
 *
 * Returns the container ref to attach and a stable `term` API used by the
 * component and the WebSocket hook to write output and drive search.
 */
export function useRunTerminal({ visible, refitKey, fontSize }: UseRunTerminalOptions): {
  termRef: React.RefObject<HTMLDivElement | null>;
  term: RunTerminal;
} {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);

  // Stable API object — methods read the live refs so the identity never
  // changes, keeping it safe to pass into other hooks/effects.
  const apiRef = useRef<RunTerminal>({
    writeln: (line) => terminalRef.current?.writeln(line),
    write: (chunk) => terminalRef.current?.write(chunk),
    clear: () => terminalRef.current?.clear(),
    fit: () => fitAddonRef.current?.fit(),
    findNext: (term) => searchAddonRef.current?.findNext(term),
    findPrevious: (term) => searchAddonRef.current?.findPrevious(term),
    clearSearch: () => searchAddonRef.current?.clearDecorations(),
    ready: () => terminalRef.current !== null,
  });

  // Terminal init (once per mount).
  useEffect(() => {
    if (!termRef.current || terminalRef.current) return;
    const term = new Terminal({
      theme: { background: '#0a0a0a', foreground: '#e5e5e5', cursor: '#e5e5e5' },
      fontFamily: 'JetBrains Mono, Fira Code, Consolas, monospace',
      convertEol: true,
      scrollback: 5000,
      cursorBlink: false,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    term.open(termRef.current);
    fitAddon.fit();
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    term.writeln('\x1b[90m[Hub] Ready. Configure and click Run.\x1b[0m');

    /**
     * Refit on the NEXT frame, coalescing a burst of size changes into one fit.
     * A zero-sized box (hidden tab, unmounting) is skipped: fitting against it
     * would store a 0-column grid that survives until the next trigger.
     */
    let pending = 0;
    const host = termRef.current;
    const scheduleFit = () => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        if (!host?.clientWidth || !host.clientHeight) return;
        fitAddon.fit();
      });
    };

    /**
     * Observe the CONTAINER, not the window. xterm paints a fixed character
     * grid, so any box change it does not know about leaves rows wider than the
     * clipped box — the terminal then visibly runs outside its frame. The
     * container covers every cause at once: divider drags, the form collapsing,
     * the sidebar rail, and window resizes.
     */
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleFit);
    if (observer && host) observer.observe(host);
    // Fallback for environments without ResizeObserver (jsdom in unit tests).
    if (!observer) window.addEventListener('resize', scheduleFit);

    return () => {
      if (pending) cancelAnimationFrame(pending);
      observer?.disconnect();
      if (!observer) window.removeEventListener('resize', scheduleFit);
      // Free xterm resources to avoid leaking DOM nodes when sessions close.
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, []);

  // Font size is a persisted preference that can change while the terminal is
  // mounted, so it is set on the live instance instead of being passed to the
  // constructor — recreating the terminal would drop the scrollback. Declared
  // after the init effect, so on mount the saved size is applied before paint.
  // A larger glyph means fewer rows/cols in the same box, hence the re-fit.
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    fitAddonRef.current?.fit();
  }, [fontSize]);

  // Re-fit when this tab becomes visible.
  useEffect(() => {
    if (visible) fitAddonRef.current?.fit();
  }, [visible]);

  // Re-fit when the caller signals a layout-affecting change (e.g. run status).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — refit only when refitKey changes.
  useEffect(() => {
    fitAddonRef.current?.fit();
  }, [refitKey]);

  return { termRef, term: apiRef.current };
}

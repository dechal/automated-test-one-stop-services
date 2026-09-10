import type { ToolId } from '@hub/shared';
import type { Simplify } from 'type-fest';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ============================================================================
// Preferences Store (persisted to localStorage)
// ============================================================================

interface Preferences {
  /** Last-used tool selection */
  lastTool: ToolId;
  /** Last-used type per tool */
  lastType: Record<ToolId, string>;
  /** Last-used project per tool+type */
  lastProject: Record<string, string>;
  /** Default run mode */
  defaultMode: 'local' | 'docker';
  /** Default headless mode */
  defaultHeadless: 'headless' | 'headed';
  /** Show onboarding card */
  showOnboarding: boolean;
  /** Sidebar collapsed on mobile */
  sidebarCollapsed: boolean;
  /**
   * Per-scheduleId switch for silent-schedule completion toasts. A missing
   * entry means enabled (default-enabled). Setting an entry to `false`
   * suppresses the Corner_Toast for that silent schedule. This lives
   * in preferences (ephemeral UI intent) and is intentionally kept out of the
   * persisted notifications store.
   */
  silentScheduleToast: Record<string, boolean>;
  /**
   * Simple view (default) vs advanced view. Off hides engineering detail that a
   * business user cannot act on — raw CLI args, exit codes, tag regexes, the
   * shell command, the live terminal — and narrows the wide tables so they fit
   * a laptop screen without a horizontal scroll. Nothing is dropped from the
   * data or the API: turning it on restores every column and field, which is
   * why it is a persisted preference and not a per-page toggle.
   */
  advancedMode: boolean;
  /**
   * Layout the user arranged, remembered instead of asked for again. These are
   * per-person and per-monitor (a 240px navbar is a fifth of a 1200px screen; a
   * comfortable terminal size differs by display), so they belong in
   * preferences rather than in a settings page.
   */
  navRailCollapsed: boolean;
  runFormCollapsed: boolean;
  /** Width of the run form column, percent of the session row. */
  runSplitPercent: number;
  /** xterm font size in px. */
  terminalFontSize: number;
  hideEmptyArtifactFolders: boolean;
}

interface PreferencesActions {
  setLastTool: (tool: ToolId) => void;
  setLastType: (tool: ToolId, type: string) => void;
  setLastProject: (tool: ToolId, type: string, project: string) => void;
  setDefaultMode: (mode: 'local' | 'docker') => void;
  setDefaultHeadless: (headless: 'headless' | 'headed') => void;
  dismissOnboarding: () => void;
  toggleOnboarding: () => void;
  /** Enable/disable the silent-schedule completion toast for one scheduleId. */
  setSilentScheduleToast: (scheduleId: string, enabled: boolean) => void;
  setAdvancedMode: (on: boolean) => void;
  setNavRailCollapsed: (collapsed: boolean) => void;
  setRunFormCollapsed: (collapsed: boolean) => void;
  setRunSplitPercent: (percent: number) => void;
  setTerminalFontSize: (px: number) => void;
  setHideEmptyArtifactFolders: (hide: boolean) => void;
}

type PreferencesStore = Simplify<Preferences & PreferencesActions>;

const DEFAULT_PREFERENCES: Preferences = {
  lastTool: 'playwright',
  lastType: { playwright: 'web', 'robot-framework': 'web', k6: 'performance' },
  lastProject: {},
  defaultMode: 'local',
  defaultHeadless: 'headless',
  showOnboarding: true,
  sidebarCollapsed: false,
  silentScheduleToast: {},
  advancedMode: false,
  navRailCollapsed: false,
  runFormCollapsed: false,
  runSplitPercent: 40,
  terminalFontSize: 12,
  hideEmptyArtifactFolders: false,
};

export const usePreferences = create<PreferencesStore>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFERENCES,
      setLastTool: (tool) => set({ lastTool: tool }),
      setLastType: (tool, type) => set((s) => ({ lastType: { ...s.lastType, [tool]: type } })),
      setLastProject: (tool, type, project) =>
        set((s) => ({ lastProject: { ...s.lastProject, [`${tool}/${type}`]: project } })),
      setDefaultMode: (mode) => set({ defaultMode: mode }),
      setDefaultHeadless: (headless) => set({ defaultHeadless: headless }),
      dismissOnboarding: () => set({ showOnboarding: false }),
      toggleOnboarding: () => set((s) => ({ showOnboarding: !s.showOnboarding })),
      setSilentScheduleToast: (scheduleId, enabled) =>
        set((s) => ({
          silentScheduleToast: { ...s.silentScheduleToast, [scheduleId]: enabled },
        })),
      setAdvancedMode: (on) => set({ advancedMode: on }),
      setNavRailCollapsed: (collapsed) => set({ navRailCollapsed: collapsed }),
      setRunFormCollapsed: (collapsed) => set({ runFormCollapsed: collapsed }),
      // Clamped so a stray drag can never leave a column unusably narrow.
      setRunSplitPercent: (percent) =>
        set({ runSplitPercent: Math.min(70, Math.max(25, Math.round(percent))) }),
      setTerminalFontSize: (px) => set({ terminalFontSize: Math.min(20, Math.max(9, px)) }),
      setHideEmptyArtifactFolders: (hide) => set({ hideEmptyArtifactFolders: hide }),
    }),
    {
      name: 'hub-preferences',
      /**
       * Shallow merge with one level of nesting for object-shaped preferences.
       * Replaces the previous `deepmerge` dependency — for our flat shape
       * (only `lastType` and `lastProject` are objects), this is sufficient
       * and avoids pulling in a 2-KB dep just for two fields.
       */
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PreferencesStore>;
        return {
          ...current,
          ...p,
          lastType: { ...current.lastType, ...(p.lastType ?? {}) },
          lastProject: { ...current.lastProject, ...(p.lastProject ?? {}) },
          silentScheduleToast: {
            ...current.silentScheduleToast,
            ...(p.silentScheduleToast ?? {}),
          },
        };
      },
    },
  ),
);

// ============================================================================
// Notification Center Store
// ============================================================================

export interface HubNotification {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
  /** Optional link to navigate to */
  link?: string;
}

interface NotificationStore {
  notifications: HubNotification[];
  unreadCount: number;
  add: (n: Omit<HubNotification, 'id' | 'timestamp' | 'read'>) => void;
  markAllRead: () => void;
  markRead: (id: string) => void;
  clear: () => void;
}

export const useNotifications = create<NotificationStore>()(
  persist(
    (set) => ({
      notifications: [],
      unreadCount: 0,
      add: (n) => {
        const notification: HubNotification = {
          ...n,
          id: Math.random().toString(36).slice(2, 10),
          timestamp: Date.now(),
          read: false,
        };
        set((s) => ({
          notifications: [notification, ...s.notifications].slice(0, 50),
          unreadCount: s.unreadCount + 1,
        }));
      },
      markAllRead: () =>
        set((s) => ({
          notifications: s.notifications.map((n) => ({ ...n, read: true })),
          unreadCount: 0,
        })),
      markRead: (id) =>
        set((s) => ({
          notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
          unreadCount: Math.max(
            0,
            s.unreadCount - (s.notifications.find((n) => n.id === id && !n.read) ? 1 : 0),
          ),
        })),
      clear: () => set({ notifications: [], unreadCount: 0 }),
    }),
    { name: 'hub-notifications' },
  ),
);

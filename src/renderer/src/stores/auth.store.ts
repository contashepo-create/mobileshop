import { create } from 'zustand';

interface AuthUser {
  userId: number;
  username: string;
  employeeId?: number;
  employeeName?: string;
  roleId: number;
  roleName: string;
  permissions: string[];
}

interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  initAuth: () => Promise<void>;
  /** UI-level permission check. The main process enforces the real rule. */
  can: (permission: string) => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  isAuthenticated: false,
  user: null,

  login: async (username: string, password: string) => {
    try {
      const result = await window.api.invoke('auth:login', { username, password });
      if (result.success) {
        set({ isAuthenticated: true, user: result.user });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  logout: async () => {
    try {
      await window.api.invoke('auth:logout');
    } catch {
      /* ignore — clear local state regardless */
    }
    set({ isAuthenticated: false, user: null });
  },

  initAuth: async () => {
    // The session lives in the MAIN process (keyed by window), so a renderer
    // reload can restore it without asking for the password again. If the main
    // process has no session we stay logged out.
    try {
      const res = await window.api.invoke('auth:session');
      if (res?.authenticated && res.user) {
        set({ isAuthenticated: true, user: res.user });
        return;
      }
    } catch {
      /* fall through to logged-out */
    }
    set({ isAuthenticated: false, user: null });
  },

  can: (permission: string) => {
    const user = get().user;
    if (!user) return false;
    return user.permissions?.includes(permission) ?? false;
  },
}));

/**
 * Returns the id of the currently authenticated user for payloads that still
 * carry it. NOTE: the main process ignores any client-supplied user id and uses
 * its own session, so this is only for optimistic UI/display purposes.
 */
export function currentUserId(): number {
  return useAuthStore.getState().user?.userId ?? 0;
}

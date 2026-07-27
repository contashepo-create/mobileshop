import { create } from 'zustand';

interface AuthUser {
  userId: number;
  username: string;
  employeeId?: number;
  employeeName?: string;
  roleId: number;
  roleName: string;
}

interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  initAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
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

  logout: () => {
    set({ isAuthenticated: false, user: null });
  },

  initAuth: async () => {
    // Check if there's a saved session (could be enhanced with electron-store)
    // For now, just set not authenticated
    set({ isAuthenticated: false });
  },
}));

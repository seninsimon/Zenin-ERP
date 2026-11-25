import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Center, Loader } from "@mantine/core";

import * as api from "../api/api";
import LoginPage from "../pages/LoginPage";
import { ChoosePasswordPage } from "../pages/PasswordPages";

export type Department = { _id: string; name: string };

export type CurrentUser = {
  _id: string;
  username: string;
  fullName: string;
  email: string;
  phone: string;
  isActive: boolean;
  // signed in with a temporary password (Import people): choose a new one first
  mustChangePassword?: boolean;
  // "Email me": now | daily (in the morning summary) | never
  emailPref?: "now" | "daily" | "never";
  // profile picture ("/uploads/…"); "" = initials
  avatarUrl?: string;
  lastLoginAt: string | null;
  role: {
    _id: string;
    name: string;
    isAdmin: boolean;
    permissions: Record<string, { view: boolean; create: boolean; edit: boolean; delete: boolean }>;
  };
  // all their roles: the main one, then app roles ("Projects · Manager")
  roleIds?: string[];
  departments: Department[];
};

type AuthContextValue = {
  user: CurrentUser;
  isAdmin: boolean;
  logout: () => Promise<void>;
  refresh: () => Promise<unknown>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const ME_KEY = ["me"];

// null when not logged in (401), so it isn't treated as an error
const fetchMe = async (): Promise<CurrentUser | null> => {
  try {
    const { data } = await api.getMe();
    return data.user;
  } catch (error: any) {
    if (error?.response?.status === 401) return null;
    throw error;
  }
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();

  const { data: user, isLoading, refetch } = useQuery({
    queryKey: ME_KEY,
    queryFn: fetchMe,
    staleTime: 60_000,
    retry: false,
  });

  // Drop every other cached query so the next user never sees the previous
  // one's data. The "me" query itself is kept (and set) because this provider
  // is subscribed to it.
  const setSessionUser = useCallback(
    (next: CurrentUser | null) => {
      qc.setQueryData(ME_KEY, next);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
    },
    [qc]
  );

  const resetSession = useCallback(() => setSessionUser(null), [setSessionUser]);

  useEffect(() => {
    window.addEventListener(api.SESSION_EXPIRED_EVENT, resetSession);
    return () => window.removeEventListener(api.SESSION_EXPIRED_EVENT, resetSession);
  }, [resetSession]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      resetSession();
    }
  }, [resetSession]);

  // the password just typed, kept in memory only for "choose your own"
  // after a temporary one, so it needn't be typed twice
  const [typedPassword, setTypedPassword] = useState<string | null>(null);
  const onLoggedIn = useCallback(
    (loggedIn: CurrentUser, password: string) => {
      setTypedPassword(loggedIn.mustChangePassword ? password : null);
      setSessionUser(loggedIn);
    },
    [setSessionUser]
  );

  const value = useMemo(
    () =>
      user
        ? { user, isAdmin: user.role.isAdmin, logout, refresh: refetch }
        : null,
    [user, logout, refetch]
  );

  if (isLoading) {
    return (
      <Center h="100vh">
        <Loader size="lg" />
      </Center>
    );
  }

  if (!value) {
    return <LoginPage onLoggedIn={onLoggedIn} />;
  }

  if (value.user.mustChangePassword) {
    return (
      <ChoosePasswordPage
        name={value.user.fullName || value.user.username}
        username={value.user.username}
        temporaryPassword={typedPassword}
        onDone={async () => {
          setTypedPassword(null);
          await refetch();
        }}
        onLogout={logout}
      />
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useCurrentUser() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useCurrentUser must be used inside <AuthProvider>");
  return ctx;
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import api, { errorMessage } from "../api";

/* ---------------- types (match the backend API, src/apps) ---------------- */

export type AppInfo = {
  key: string;
  name: string;
  description: string;
  icon: string;
  group: string;
  // People, Customers, Products: added by the apps that need them, not on their own
  part?: boolean;
  needs: string[];
  tables: { key: string; label: string; description: string }[];
  // made here: New app, My tables, or drafted with AI (can be renamed)
  own?: boolean;
  installed: {
    version: number;
    installedAt: string;
    // tables it created (removed with it)
    tables: string[];
    // apps you made: every table in it now
    inApp?: string[];
    sampleRecords: number;
  } | null;
};

export type InstallOptions = {
  tables?: Record<string, boolean>;
  departmentIds?: string[];
  sampleData?: boolean;
  conflicts?: Record<string, "new" | "use">;
};

export type PlannedTable = {
  key: string;
  app: string;
  label: string;
  description: string;
  action: "create" | "reuse" | "use" | "skip";
  tableName: string | null;
  optional: boolean;
  links: { column: string; to: string; toLabel: string }[];
  dropped: string[];
  conflict: { existing: string; choice: "new" | "use" } | null;
};

export type InstallPlan = {
  apps: { key: string; name: string; status: "install" | "installed"; pulledIn: boolean }[];
  tables: PlannedTable[];
  roles: { name: string; level: string; action: "create" | "extend"; tables: string[] }[];
  hasSample: boolean;
};

export type InstallResult = {
  apps: string[];
  tables: { key: string; tableName: string; label: string; action: string }[];
  sampleRecords: number;
};

/* ---------------- hooks ---------------- */

export const useApps = () =>
  useQuery({
    queryKey: ["apps"],
    queryFn: async () =>
      (await api.get<{ apps: AppInfo[]; aiDrafts: boolean; aiName: string | null; icons: string[] }>("/apps")).data,
  });

// What installing would do; refreshed whenever the choices change.
// draft: an app drafted with AI (sent instead of app keys)
export const useInstallPlan = (apps: string[] | null, options: InstallOptions, draft?: unknown) =>
  useQuery({
    queryKey: ["appPlan", apps, options, draft ?? null],
    queryFn: async () => (await api.post<InstallPlan>("/apps/plan", { apps, options, draft })).data,
    enabled: Boolean(apps?.length || draft),
    placeholderData: (previous) => previous,
  });

// apps change tables, roles and the sidebar
const refreshAll = (qc: ReturnType<typeof useQueryClient>) => {
  for (const key of ["apps", "tables", "schema", "roles", "users", "appAccessOptions", "tableData", "related", "tableUse"]) qc.invalidateQueries({ queryKey: [key] });
};

const fail = (title: string) => (error: unknown) =>
  notifications.show({ title, message: errorMessage(error), color: "red" });

export const useInstallApps = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { apps: string[]; options: InstallOptions; draft?: unknown }) =>
      (await api.post<InstallResult>("/apps/install", input)).data,
    onSuccess: () => refreshAll(qc),
    onError: fail("Couldn't add the app"),
  });
};

// "Describe your organization": the AI drafts an app (nothing is created yet)
export const useDraftApp = () =>
  useMutation({
    mutationFn: async (description: string) =>
      (await api.post<{ draft: unknown; app: { key: string; name: string; description: string } }>("/apps/draft", { description }, { timeout: 180_000 }))
        .data,
    onError: fail("Couldn't draft the app"),
  });

export const useUninstallApp = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) => (await api.delete<{ removedTables: string[] }>(`/apps/${key}`)).data,
    onSuccess: (data) => {
      refreshAll(qc);
      notifications.show({
        title: "App removed",
        message: data.removedTables.length
          ? `Deleted ${data.removedTables.length} table${data.removedTables.length === 1 ? "" : "s"}`
          : "Its tables are in My tables now",
        color: "green",
      });
    },
    onError: fail("Couldn't remove the app"),
  });
};

export const useRemoveSample = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) => (await api.delete<{ removed: number }>(`/apps/${key}/sample`)).data,
    onSuccess: (data) => {
      refreshAll(qc);
      notifications.show({ title: "Sample records removed", message: `${data.removed} removed`, color: "green" });
    },
    onError: fail("Couldn't remove the sample records"),
  });
};

/* ---------------- apps you make; where a table goes ---------------- */

export type TableHome = { key: string; name: string; icon: string; own: boolean };

// the apps a table can be added to or moved into (My tables first)
export const useTableHomes = () =>
  useQuery({
    queryKey: ["apps", "homes"],
    queryFn: async () => (await api.get<TableHome[]>("/apps/homes")).data,
  });

export const useCreateOwnApp = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; icon: string }) => (await api.post<{ key: string; name: string; icon: string }>("/apps/own", input)).data,
    onSuccess: (app) => {
      refreshAll(qc);
      notifications.show({ title: "App made", message: `${app.name} is ready. Add tables to it from Tables & columns.`, color: "green" });
    },
  });
};

export const useRenameApp = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, ...input }: { key: string; name: string; icon: string }) => (await api.put(`/apps/${key}`, input)).data,
    onSuccess: () => {
      refreshAll(qc);
      notifications.show({ title: "App renamed", message: "Saved", color: "green" });
    },
  });
};

// move a table you made to another app
export const useMoveTable = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ table, app }: { table: string; app: string }) => (await api.put<{ message: string }>(`/schema/${table}/app`, { app })).data,
    onSuccess: (data) => {
      refreshAll(qc);
      notifications.show({ title: "Table moved", message: data.message, color: "green" });
    },
    onError: fail("Couldn't move the table"),
  });
};

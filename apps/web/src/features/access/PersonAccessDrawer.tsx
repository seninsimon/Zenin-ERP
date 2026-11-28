import { Alert, Badge, Drawer, Group, Skeleton, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconAlertTriangle, IconShieldCheck } from "@tabler/icons-react";

import { errorMessage } from "../../api/api";
import { usePersonAccess, type TableAccessRow } from "../../api/reactQueryHooks/useAdmin";
import { tableTitle } from "../../layout/nav";
import { joinAnd, joinOr, rightsInWords, scopeInWords } from "../../lib/accessWords";
import { AppIcon } from "../apps/AppIcon";

const MY_TABLES = { key: "", name: "My tables", icon: "IconTable" };
const levelName = (level: string) => level.charAt(0).toUpperCase() + level.slice(1);

// "What they can do" in a side panel (Users → a person's menu).
export function PersonAccessDrawer({
  person,
  onClose,
}: {
  person: { _id: string; fullName?: string; username: string } | null;
  onClose: () => void;
}) {
  const narrow = useMediaQuery("(max-width: 48em)");
  const name = person ? person.fullName || person.username : "";
  return (
    <Drawer opened={Boolean(person)} onClose={onClose} position="right" size={narrow ? "100%" : "md"} title={`What ${name} can do`}>
      {person && <PersonAccessSummary userId={person._id} />}
    </Drawer>
  );
}

// "What they can do": every table this person can open, in plain words,
// grouped by app, and why a table they'd expect is closed. The server works
// it out with the same rules it enforces, so it's never a guess.
export function PersonAccessSummary({
  userId,
  unsaved,
}: {
  userId: string;
  // shown inside a form with changes not saved yet
  unsaved?: boolean;
}) {
  const { data, isLoading, error } = usePersonAccess(userId);

  // by app, in the sidebar's order: Company first, your own tables last
  const groups = new Map<string, { app: { key: string; name: string; icon: string }; open: TableAccessRow[]; closed: TableAccessRow[] }>();
  for (const t of data?.tables ?? []) {
    const app = t.app ?? MY_TABLES;
    const g = groups.get(app.key) ?? { app, open: [], closed: [] };
    (t.view ? g.open : g.closed).push(t);
    groups.set(app.key, g);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    const rank = (k: string) => (k === "company" ? 0 : k === "" ? 2 : 1);
    return rank(a.app.key) - rank(b.app.key) || a.app.name.localeCompare(b.app.name);
  });
  const withAccess = ordered.filter((g) => g.open.length);
  const blocked = (data?.tables ?? []).filter((t) => t.needsDepartment);
  const noAccessApps = ordered.filter((g) => !g.open.length && !g.closed.some((t) => t.needsDepartment));

  return (
    <>
      {isLoading ? (
        <Stack>
          <Skeleton h={50} />
          <Skeleton h={90} />
          <Skeleton h={90} />
        </Stack>
      ) : error ? (
        <Alert color="red">{errorMessage(error)}</Alert>
      ) : data ? (
        <Stack gap="lg">
          {unsaved && (
            <Alert color="yellow" variant="light" p="sm">
              This shows what's saved. Save your changes to see them here.
            </Alert>
          )}

          {data.admin ? (
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <IconShieldCheck size={22} color="var(--mantine-color-red-6)" />
              <Text size="sm">
                <b>Administrator:</b> can do everything, in every app and table, including Settings.
              </Text>
            </Group>
          ) : (
            <>
              <Text size="sm" c="dimmed">
                {data.departments.length ? `Departments: ${joinAnd(data.departments)}.` : "Not in any department."}{" "}
                {data.role !== "Member" && `Role: ${data.role}.`}
              </Text>

              {blocked.length > 0 && (
                <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} title="Closed because of departments">
                  <Stack gap={4}>
                    {blocked.map((t) => (
                      <Text size="sm" key={t.tableName}>
                        <b>{tableTitle(t.tableName)}</b>:{" "}
                        {t.needsDepartment!.length
                          ? `their access allows it, but they're not in ${joinOr(t.needsDepartment!)}. Add ${t.needsDepartment!.length > 1 ? "one of those departments" : "that department"} to them to open it.`
                          : "the table is split by department but has none, so only admins can open it."}
                      </Text>
                    ))}
                  </Stack>
                </Alert>
              )}

              {withAccess.length === 0 && (
                <Text size="sm">
                  <b>No access to any table yet.</b> Give them Staff or Manager in an app under App access.
                </Text>
              )}

              {withAccess.map(({ app, open, closed }) => {
                const level = data.appLevels[app.key];
                return (
                  <Stack key={app.key || "mine"} gap={6}>
                    <Group gap="sm" wrap="nowrap">
                      <AppIcon name={app.icon} size={26} />
                      <Text fw={600} size="sm">
                        {app.name}
                      </Text>
                      {level && (
                        <Badge variant="light" size="sm">
                          {levelName(level)}
                        </Badge>
                      )}
                    </Group>
                    <Stack gap={4} pl={34}>
                      {open.map((t) => (
                        <Text size="sm" key={t.tableName}>
                          <b>{tableTitle(t.tableName)}</b>: {rightsInWords(t).toLowerCase()}, {scopeInWords(t.own, t.departments)}
                        </Text>
                      ))}
                      {closed.filter((t) => !t.needsDepartment).length > 0 && (
                        <Text size="sm" c="dimmed">
                          No access: {joinAnd(closed.filter((t) => !t.needsDepartment).map((t) => tableTitle(t.tableName)))}
                        </Text>
                      )}
                    </Stack>
                  </Stack>
                );
              })}

              {noAccessApps.length > 0 && (
                <Text size="sm" c="dimmed">
                  No access to {joinAnd(noAccessApps.map((g) => g.app.name))}.
                </Text>
              )}
            </>
          )}
        </Stack>
      ) : null}
    </>
  );
}

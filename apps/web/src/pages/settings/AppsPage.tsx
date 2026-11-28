import { useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  UnstyledButton,
  Checkbox,
  Drawer,
  Group,
  Menu,
  Modal,
  Radio,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconDots, IconEraser, IconPencil, IconPlus, IconSparkles, IconTrash } from "@tabler/icons-react";
import { Link, useNavigate } from "react-router-dom";

import { useDepartments } from "../../api/reactQueryHooks/useAdmin";
import {
  useApps,
  useCreateOwnApp,
  useDraftApp,
  useRenameApp,
  useInstallApps,
  useInstallPlan,
  useRemoveSample,
  useUninstallApp,
  type AppInfo,
  type InstallOptions,
} from "../../api/reactQueryHooks/useApps";
import { Page, PageHeader, Section } from "../../components/ui/Page";
import { tablePath, tableTitle } from "../../layout/nav";
import { AppIcon } from "../../features/apps/AppIcon";
import { errorMessage } from "../../api/api";
import classes from "./settings.module.css";

/* ---------------- install preview ---------------- */

type Target = { title: string; apps: string[]; draft?: unknown };

function InstallDrawer({ target, onClose }: { target: Target | null; onClose: () => void }) {
  const navigate = useNavigate();
  const narrow = useMediaQuery("(max-width: 48em)");
  const { data: departments = [] } = useDepartments();
  const [tables, setTables] = useState<Record<string, boolean>>({});
  const [conflicts, setConflicts] = useState<Record<string, "new" | "use">>({});
  const [sampleData, setSampleData] = useState(false);
  const install = useInstallApps();

  const { data: plan, isLoading, error } = useInstallPlan(target?.apps ?? null, { tables, conflicts }, target?.draft);
  // the tables are shared with every department, so switching one to
  // "each department only its own" later just works
  const shareWith = departments.map((d) => d._id);
  const options: InstallOptions = { tables, conflicts, departmentIds: shareWith, sampleData };

  const reset = () => {
    setTables({});
    setConflicts({});
    setSampleData(false);
  };
  const close = () => {
    reset();
    onClose();
  };

  const pulledIn = plan?.apps.filter((a) => a.pulledIn && a.status === "install") ?? [];
  const already = plan?.apps.filter((a) => a.status === "installed" && !a.pulledIn) ?? [];
  const nothingToDo = plan && plan.apps.every((a) => a.status === "installed");

  const submit = async () => {
    if (!target) return;
    const result = await install.mutateAsync({ apps: target.apps, options, draft: target.draft });
    notifications.show({
      title: `${target.title} added`,
      message: `${result.tables.map((t) => tableTitle(t.tableName)).join(", ")}${result.sampleRecords ? `, with ${result.sampleRecords} sample records` : ""}`,
      color: "green",
    });
    const first = result.tables.find((t) => t.action === "create");
    close();
    if (first) navigate(tablePath(first.tableName));
  };

  return (
    <Drawer
      opened={Boolean(target)}
      onClose={close}
      position="right"
      size={narrow ? "100%" : "lg"}
      title={target ? `Add ${target.title}` : ""}
    >
      {!plan && isLoading ? (
        <Stack>
          <Skeleton h={60} />
          <Skeleton h={60} />
          <Skeleton h={60} />
        </Stack>
      ) : error ? (
        <Alert color="red">Couldn't prepare this app. Try again.</Alert>
      ) : plan ? (
        <Stack gap="lg">
          {pulledIn.length > 0 && (
            <Text size="sm">
              Also adds <b>{pulledIn.map((a) => a.name).join(", ")}</b>, which {pulledIn.length === 1 ? "it builds" : "they build"} on.
            </Text>
          )}
          {already.length > 0 && (
            <Text size="sm" c="dimmed">
              Already added: {already.map((a) => a.name).join(", ")}.
            </Text>
          )}

          <Stack gap="xs">
            <Text fw={600} size="sm">
              Tables
            </Text>
            {plan.tables.map((t) => (
              <Card key={t.key} withBorder padding="sm" radius="md">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  {t.action === "reuse" ? (
                    <div>
                      <Text size="sm" fw={500}>
                        {t.label}
                      </Text>
                      <Text size="xs" c="dimmed">
                        Already there: uses your {tableTitle(t.tableName ?? "")} table
                      </Text>
                    </div>
                  ) : t.optional ? (
                    <Checkbox
                      // the click shows at once; the preview below catches up
                      checked={tables[t.key] ?? t.action !== "skip"}
                      onChange={(e) => setTables((prev) => ({ ...prev, [t.key]: e.currentTarget.checked }))}
                      label={
                        <Text size="sm" fw={500}>
                          {t.label}
                        </Text>
                      }
                      description={t.description}
                    />
                  ) : (
                    // the app's main table: always added, so no checkbox to wonder about
                    <Group gap={10} wrap="nowrap" align="flex-start">
                      <IconCheck size={18} color="var(--mantine-color-teal-6)" style={{ flexShrink: 0, marginTop: 1 }} aria-hidden />
                      <div>
                        <Text size="sm" fw={500}>
                          {t.label}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {t.description}
                        </Text>
                      </div>
                    </Group>
                  )}
                  {t.action !== "skip" && t.action !== "reuse" && t.links.length > 0 && (
                    <Text size="xs" c="dimmed" ta="right" style={{ flexShrink: 0 }}>
                      {t.links.map((l) => `${l.column} → ${l.toLabel}`).join(" · ")}
                    </Text>
                  )}
                </Group>
                {t.action !== "skip" && t.dropped.length > 0 && (
                  <Text size="xs" c="var(--mantine-color-orange-light-color)" mt={6}>
                    Without the tables you left out, it won't have: {t.dropped.join(", ")}
                  </Text>
                )}
                {t.conflict && (
                  <Radio.Group
                    mt="sm"
                    value={t.conflict.choice}
                    onChange={(v) => setConflicts((prev) => ({ ...prev, [t.key]: v as "new" | "use" }))}
                    label={<Text size="xs">You already have a table called “{tableTitle(t.conflict.existing)}”.</Text>}
                  >
                    <Stack gap={6} mt={6}>
                      <Radio size="xs" value="new" label={`Create a new one (${tableTitle(t.tableName && t.conflict.choice === "new" ? t.tableName : `${t.conflict.existing}_2`)})`} />
                      <Radio size="xs" value="use" label="Use mine (adds the columns it lacks, changes nothing else)" />
                    </Stack>
                  </Radio.Group>
                )}
              </Card>
            ))}
          </Stack>

          {plan.roles.length > 0 && (
            <Stack gap={4}>
              <Text fw={600} size="sm">
                Who can use it
              </Text>
              <Text size="sm" c="dimmed">
                Afterwards, give people access on their page under <b>Users</b>: <b>Staff</b> for everyday work (personal
                records like leave only their own) or <b>Manager</b> for everything, including approvals.
              </Text>
            </Stack>
          )}

          {plan.hasSample && (
            <Checkbox
              checked={sampleData}
              onChange={(e) => setSampleData(e.currentTarget.checked)}
              label="Add a few sample records to try it out"
              description="You can remove just the samples later, on this page"
            />
          )}

          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button onClick={submit} loading={install.isPending} disabled={Boolean(nothingToDo)}>
              {nothingToDo ? "Already added" : "Add"}
            </Button>
          </Group>
        </Stack>
      ) : null}
    </Drawer>
  );
}

/* ---------------- remove ---------------- */

function RemoveAppModal({ app, onClose }: { app: AppInfo | null; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const uninstall = useUninstallApp();
  const close = () => {
    setTyped("");
    onClose();
  };
  // apps that created tables delete them; apps you made move theirs to My tables
  const deletes = Boolean(app?.installed?.tables.length);
  const moves = (app?.installed?.inApp ?? []).filter((t) => !app?.installed?.tables.includes(t));
  return (
    <Modal opened={Boolean(app)} onClose={close} title={`Remove ${app?.name ?? ""}`}>
      {app && (
        <Stack>
          {deletes ? (
            <Text size="sm">
              This deletes the tables it added ({app.installed!.tables.map(tableTitle).join(", ")}) <b>with all their records</b>. It can't be
              undone.{app.own ? " Tables you added to it later move to My tables." : ""}
            </Text>
          ) : (
            <Text size="sm">
              {moves.length ? (
                <>
                  Its tables ({moves.map(tableTitle).join(", ")}) move to My tables, <b>with all their records</b>.{" "}
                </>
              ) : (
                "It has no tables. "
              )}
              People lose the access this app gave them.
            </Text>
          )}
          {deletes && (
            <TextInput label={`Type "${app.name}" to confirm`} value={typed} onChange={(e) => setTyped(e.currentTarget.value)} data-autofocus />
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button
              color="red"
              disabled={deletes && typed.trim() !== app.name}
              loading={uninstall.isPending}
              onClick={() => uninstall.mutateAsync(app.key).then(close, () => {})}
            >
              Remove app
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

/* ---------------- your own apps: new and rename ---------------- */

function AppNameModal({
  opened,
  app,
  icons,
  onClose,
}: {
  opened: boolean;
  // null = a new app
  app: AppInfo | null;
  icons: string[];
  onClose: () => void;
}) {
  const create = useCreateOwnApp();
  const rename = useRenameApp();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("IconApps");
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<string | null>(null);
  // fill in when opened (state from props, without an effect)
  const openedFor = opened ? (app?.key ?? "new") : null;
  if (openedFor !== seen) {
    setSeen(openedFor);
    setName(app?.name ?? "");
    setIcon(app?.icon ?? "IconApps");
    setError(null);
  }
  const busy = create.isPending || rename.isPending;
  const save = async () => {
    try {
      if (app) await rename.mutateAsync({ key: app.key, name: name.trim(), icon });
      else await create.mutateAsync({ name: name.trim(), icon });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Modal opened={opened} onClose={onClose} title={app ? `Rename ${app.name}` : "New app"}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack>
          {!app && (
            <Text size="sm" c="dimmed">
              An app groups tables for one kind of work, with its own Staff and Manager. Add tables to it from Tables & columns.
            </Text>
          )}
          <TextInput
            label="Name"
            placeholder="e.g. Purchasing"
            withAsterisk
            maxLength={40}
            data-autofocus
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value);
              setError(null);
            }}
            error={error}
          />
          <div>
            <Text size="sm" fw={500} mb={6}>
              Icon
            </Text>
            <SimpleGrid cols={8} spacing={6} role="radiogroup" aria-label="Icon">
              {icons.map((i) => (
                <UnstyledButton
                  key={i}
                  role="radio"
                  aria-checked={icon === i}
                  aria-label={i.replace(/^Icon/, "")}
                  className={classes.iconChoice}
                  data-selected={icon === i || undefined}
                  onClick={() => setIcon(i)}
                >
                  <AppIcon name={i} size={30} />
                </UnstyledButton>
              ))}
            </SimpleGrid>
          </div>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!name.trim()}>
              {app ? "Save" : "Make app"}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/* ---------------- draft with AI ---------------- */

function DraftAiModal({
  opened,
  onClose,
  aiDrafts,
  aiName,
  onDrafted,
}: {
  opened: boolean;
  onClose: () => void;
  aiDrafts: boolean;
  aiName: string | null;
  onDrafted: (target: Target) => void;
}) {
  const [description, setDescription] = useState("");
  const draftApp = useDraftApp();
  // failures are shown by the hook (a notification)
  const draft = () =>
    draftApp.mutateAsync(description.trim()).then(
      (result) => {
        onDrafted({ title: result.app.name, apps: [], draft: result.draft });
        setDescription("");
      },
      () => {}
    );
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          Draft an app with AI
          <Badge variant="light" color="violet">
            Beta
          </Badge>
        </Group>
      }
    >
      {aiDrafts ? (
        <Stack>
          <Text size="sm" c="dimmed">
            Say what you do in a sentence or two. AI{aiName ? ` (${aiName})` : ""} drafts the tables; you see them before anything is added,
            and can change everything afterwards. AI can make mistakes: check before relying on it.
          </Text>
          <Textarea
            aria-label="What you do"
            placeholder="e.g. We're a 12-person dental clinic with two branches. We book appointments, keep treatment notes and bill patients."
            autosize
            minRows={3}
            maxRows={6}
            maxLength={2000}
            data-autofocus
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <Group justify="space-between" gap="xs">
            <Text size="xs" c="dimmed">
              {draftApp.isPending ? "Drafting… this can take up to a minute." : ""}
            </Text>
            <Button leftSection={<IconSparkles size={16} />} onClick={draft} loading={draftApp.isPending} disabled={description.trim().length < 10}>
              Draft tables
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack align="flex-start">
          <Text size="sm">To use this, choose an AI (Claude, Gemini or ChatGPT) in Settings → AI, paste its key and switch on Draft apps.</Text>
          <Button variant="light" component={Link} to="/settings/ai" leftSection={<IconSparkles size={16} />}>
            Set up AI
          </Button>
        </Stack>
      )}
    </Modal>
  );
}

/* ---------------- page ---------------- */

// most needed first; apps for one kind of organization last
const ORDER = ["hr", "expenses", "projects", "crm", "billing", "inventory", "payroll", "clinic", "school"];
// what most businesses start with (offered while nothing is added)
const STARTER = ["hr", "expenses", "projects"];
const rank = (key: string) => (ORDER.includes(key) ? ORDER.indexOf(key) : ORDER.length);

// One app as a short row: icon, name, one line, and its action on the right.
function AppRow({ app, detail, action }: { app: AppInfo; detail: string; action: React.ReactNode }) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="sm" px="lg" py="sm" className={classes.appRow}>
      <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
        <AppIcon name={app.icon} size={32} />
        <div style={{ minWidth: 0 }}>
          <Text fw={500} size="sm">
            {app.name}
          </Text>
          <Text size="xs" c="dimmed" lineClamp={2}>
            {detail}
          </Text>
        </div>
      </Group>
      {action}
    </Group>
  );
}

export default function AppsPage() {
  const { data, isLoading } = useApps();
  const [target, setTarget] = useState<Target | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [removing, setRemoving] = useState<AppInfo | null>(null);
  const [naming, setNaming] = useState<{ app: AppInfo | null } | null>(null);
  const removeSample = useRemoveSample();

  const apps = useMemo(() => data?.apps ?? [], [data]);
  // everything added, in one list: ready-made apps first, then your own, My tables last
  const added = apps
    // My tables only once it has tables (an empty one is just noise)
    .filter((a) => a.installed && !a.part && (a.key !== "my-tables" || (a.installed.inApp ?? []).length > 0))
    .sort((a, b) => Number(Boolean(a.own)) - Number(Boolean(b.own)) || (a.key === "my-tables" ? 1 : b.key === "my-tables" ? -1 : rank(a.key) - rank(b.key) || a.name.localeCompare(b.name)));
  // People, Customers and Products come with the apps that need them
  const available = apps.filter((a) => !a.installed && !a.part && !a.own).sort((a, b) => rank(a.key) - rank(b.key));
  const nothingYet = !apps.some((a) => a.installed && !a.own && !a.part);
  const starter = STARTER.filter((k) => available.some((a) => a.key === k));

  const addButton = (app: AppInfo) => (
    <Button size="xs" variant="light" style={{ flexShrink: 0 }} onClick={() => setTarget({ title: app.name, apps: [app.key] })}>
      Add
    </Button>
  );

  return (
    <Page title="Manage apps" breadcrumbs={[{ label: "Settings", to: "/settings" }, { label: "Manage apps" }]}>
      <PageHeader
        title="Manage apps"
        help="apps"
        description="Ready-made, connected tables for the work you do. Everything an app adds is yours to change afterwards."
        actions={
          <Group gap="xs">
            <Button variant="default" leftSection={<IconSparkles size={16} />} onClick={() => setDrafting(true)}>
              Draft with AI
            </Button>
            <Button leftSection={<IconPlus size={16} />} onClick={() => setNaming({ app: null })}>
              New app
            </Button>
          </Group>
        }
      />
      {isLoading ? (
        <Skeleton h={240} radius="lg" />
      ) : (
        <Stack gap="lg">
          {nothingYet && starter.length === STARTER.length && (
            <Section padding="md">
              <Group justify="space-between" gap="sm">
                <Text size="sm">
                  <b>New here?</b> Most businesses start with HR & leave, Expense claims and Projects.
                </Text>
                <Button size="xs" onClick={() => setTarget({ title: "HR & leave, Expense claims and Projects", apps: STARTER })}>
                  Add these 3
                </Button>
              </Group>
            </Section>
          )}

          {added.length > 0 && (
            <Section title="Your apps" description="Their tables are in the sidebar, grouped by app." padding={0}>
              {added.map((app) => {
                const tables = app.installed!.inApp ?? app.installed!.tables;
                const samples = app.installed!.sampleRecords;
                const canRemove = app.key !== "my-tables";
                return (
                  <AppRow
                    key={app.key}
                    app={app}
                    detail={tables.length ? tables.map(tableTitle).join(", ") : app.own ? "No tables yet: add them from Tables & columns" : "Uses tables you already had"}
                    action={
                      <Menu position="bottom-end" withinPortal>
                        <Menu.Target>
                          <ActionIcon variant="subtle" color="gray" aria-label={`${app.name}: more`}>
                            <IconDots size={18} />
                          </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                          {app.own && (
                            <Menu.Item leftSection={<IconPencil size={16} />} onClick={() => setNaming({ app })}>
                              Rename
                            </Menu.Item>
                          )}
                          {samples > 0 && (
                            <Menu.Item leftSection={<IconEraser size={16} />} onClick={() => removeSample.mutate(app.key)}>
                              Remove {samples} sample records
                            </Menu.Item>
                          )}
                          {canRemove && (
                            <>
                              {(app.own || samples > 0) && <Menu.Divider />}
                              <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => setRemoving(app)}>
                                Remove app
                              </Menu.Item>
                            </>
                          )}
                        </Menu.Dropdown>
                      </Menu>
                    }
                  />
                );
              })}
            </Section>
          )}

          {available.length > 0 && (
            <Section title="Add an app" description="You'll see what it adds before anything changes." padding={0}>
              {available.map((app) => (
                <AppRow key={app.key} app={app} detail={app.description} action={addButton(app)} />
              ))}
            </Section>
          )}
        </Stack>
      )}

      <InstallDrawer target={target} onClose={() => setTarget(null)} />
      <RemoveAppModal app={removing} onClose={() => setRemoving(null)} />
      <AppNameModal opened={naming !== null} app={naming?.app ?? null} icons={data?.icons ?? []} onClose={() => setNaming(null)} />
      <DraftAiModal
        opened={drafting}
        onClose={() => setDrafting(false)}
        aiDrafts={Boolean(data?.aiDrafts)}
        aiName={data?.aiName ?? null}
        onDrafted={(t) => {
          setDrafting(false);
          setTarget(t);
        }}
      />
    </Page>
  );
}

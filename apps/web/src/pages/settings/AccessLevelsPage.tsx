import { useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Checkbox,
  Grid,
  Group,
  Menu,
  Modal,
  NavLink,
  Paper,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconAlertTriangle, IconArrowRight, IconDots, IconPlus, IconRestore, IconSearch, IconTrash, IconUser } from "@tabler/icons-react";
import { useSearchParams } from "react-router-dom";

import { errorMessage } from "../../api/api";
import {
  useAccessLevels,
  useAddLevel,
  useDeleteLevel,
  useMoveOlderRoles,
  useResetLevel,
  useSaveLevels,
  type AppLevels,
  type MovePreview,
  type PermissionMap,
  type TablePermission,
} from "../../api/reactQueryHooks/useAdmin";
import { confirmDanger } from "../../components/ui/confirm";
import { HelpTip } from "../../components/ui/HelpTip";
import { Page, PageHeader } from "../../components/ui/Page";
import { AppIcon } from "../../features/apps/AppIcon";
import { tableTitle } from "../../layout/nav";
import { pluralize } from "../../lib/format";
import classes from "./settings.module.css";

// Settings → Access levels: one app at a time, as a grid. Rows are the
// app's tables, columns its levels (Staff, Manager, added ones); each cell is
// one choice plus "only their own". One Save for the whole app.

/* ---------------- one simple choice per cell ---------------- */

const NONE: TablePermission = { view: false, create: false, edit: false, delete: false };
const PRESETS = {
  none: { label: "No access", perm: NONE },
  view: { label: "View", perm: { view: true, create: false, edit: false, delete: false } },
  add: { label: "View + add", perm: { view: true, create: true, edit: false, delete: false } },
  work: { label: "View, add, edit", perm: { view: true, create: true, edit: true, delete: false } },
  all: { label: "Everything", perm: { view: true, create: true, edit: true, delete: true } },
} as const;
type Preset = keyof typeof PRESETS | "custom";
const PRESET_DATA = [...Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })), { value: "custom", label: "Custom…" }];

const presetOf = (p: TablePermission | undefined): Preset => {
  if (!p?.view) return "none";
  const found = Object.entries(PRESETS).find(
    ([, x]) => x.perm.view && x.perm.create === Boolean(p.create) && x.perm.edit === Boolean(p.edit) && x.perm.delete === Boolean(p.delete)
  );
  return (found?.[0] as Preset) ?? "custom";
};

const ACTIONS = [
  ["view", "View"],
  ["create", "Add"],
  ["edit", "Edit"],
  ["delete", "Delete"],
] as const;

const same = (a: TablePermission | undefined, b: TablePermission | undefined) =>
  Boolean(a?.view) === Boolean(b?.view) &&
  (!a?.view ||
    (Boolean(a.create) === Boolean(b?.create) && Boolean(a.edit) === Boolean(b?.edit) && Boolean(a.delete) === Boolean(b?.delete) && Boolean(a.own) === Boolean(b?.own)));

function Cell({
  label,
  value,
  changed,
  onChange,
  custom,
  onCustom,
}: {
  // "Deals for Staff", for screen readers
  label: string;
  value: TablePermission | undefined;
  changed: boolean;
  onChange: (next: TablePermission | undefined) => void;
  // "Custom…" picked: show the four ticks even when they match a choice
  custom: boolean;
  onCustom: (on: boolean) => void;
}) {
  const preset = custom ? "custom" : presetOf(value);
  const own = Boolean(value?.own);
  // rights that match no simple choice: a short summary until "Change" is clicked
  const summary = ACTIONS.filter(([a]) => value?.[a]).map(([, t]) => t.toLowerCase()).join(", ");
  return (
    <Stack gap={4} className={changed ? classes.changedCell : undefined}>
      <Group gap={4} wrap="nowrap">
        <Select
          size="xs"
          w={138}
          aria-label={`What ${label} can do`}
          data={PRESET_DATA}
          value={preset}
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
          onChange={(v) => {
            if (v === "custom") return onCustom(true);
            onCustom(false);
            const p = PRESETS[v as keyof typeof PRESETS].perm;
            onChange(p.view ? { ...p, ...(own ? { own: true } : {}) } : undefined);
          }}
        />
        <Tooltip label={own ? "Only their own records (on)" : "Only their own records (off)"} withArrow>
          <ActionIcon
            size={30}
            variant={own ? "filled" : "default"}
            aria-label={`Only their own records: ${label}`}
            aria-pressed={own}
            disabled={!value?.view}
            onClick={() => value && onChange({ ...value, own: !own || undefined })}
          >
            <IconUser size={15} />
          </ActionIcon>
        </Tooltip>
      </Group>
      {preset === "custom" && !custom && (
        <Group gap={6}>
          <Text size="xs" c="dimmed">
            {summary.charAt(0).toUpperCase() + summary.slice(1)}
          </Text>
          <Anchor component="button" type="button" size="xs" onClick={() => onCustom(true)} aria-label={`Change the ticks: ${label}`}>
            Change
          </Anchor>
        </Group>
      )}
      {custom && (
        <Group gap={6} maw={180}>
          {ACTIONS.map(([action, text]) => (
            <Checkbox
              key={action}
              size="xs"
              label={text}
              checked={Boolean(value?.[action])}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                const base = value ?? NONE;
                // adding, editing or deleting needs viewing; no viewing means nothing
                const next = action === "view" ? (on ? { ...base, view: true } : NONE) : { ...base, [action]: on, ...(on ? { view: true } : {}) };
                onChange(next.view ? next : undefined);
              }}
            />
          ))}
        </Group>
      )}
    </Stack>
  );
}

/* ---------------- add a level ---------------- */

function AddLevelModal({ app, opened, onClose }: { app: AppLevels; opened: boolean; onClose: () => void }) {
  const add = useAddLevel();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setName("");
    setError(null);
    onClose();
  };
  return (
    <Modal opened={opened} onClose={close} title={`Add a level to ${app.name}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add.mutateAsync({ app: app.key, name: name.trim() }).then(close, (err) => setError(errorMessage(err)));
        }}
      >
        <Stack>
          <Text size="sm" c="dimmed">
            For a job between Staff and Manager. It starts with no access: choose what it can do in its new column.
          </Text>
          <TextInput
            label="Name"
            placeholder="e.g. Accountant"
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
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={add.isPending} disabled={!name.trim()}>
              Add level
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/* ---------------- one app: the grid ---------------- */

type Drafts = Record<string, PermissionMap>; // level -> what it may do, changed

function AppGrid({ app, drafts, setDrafts }: { app: AppLevels; drafts: Drafts; setDrafts: (d: Drafts) => void }) {
  const [custom, setCustom] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const save = useSaveLevels();
  const reset = useResetLevel();
  const remove = useDeleteLevel();

  const current = (level: string) => drafts[level] ?? app.levels.find((l) => l.level === level)!.permissions;
  const changedCells = app.levels.flatMap((l) =>
    drafts[l.level] ? app.tables.filter((t) => !same(drafts[l.level][t], l.permissions[t])).map((t) => `${l.level}:${t}`) : []
  );
  const changed = new Set(changedCells);
  const setCell = (level: string, table: string, p: TablePermission | undefined) => {
    const next = { ...current(level) };
    if (p?.view) next[table] = p;
    else delete next[table];
    setDrafts({ ...drafts, [level]: next });
  };
  const saveAll = () => {
    const levels = Object.entries(drafts)
      .filter(([level]) => app.tables.some((t) => changed.has(`${level}:${t}`)))
      .map(([level, permissions]) => ({ level, permissions }));
    save.mutateAsync({ app: app.key, levels }).then(
      () => setDrafts({}),
      () => {}
    );
  };

  return (
    <Paper withBorder radius="lg" p={0} style={{ overflow: "hidden" }}>
      <Group justify="space-between" px="lg" py="md" gap="sm" wrap="wrap" style={{ borderBottom: "1px solid var(--app-border)" }}>
        <Group gap="sm" wrap="nowrap">
          <AppIcon name={app.icon} size={32} />
          <div>
            <Text fw={600}>{app.name}</Text>
            <Text size="xs" c="dimmed">
              {pluralize(app.tables.length, "table")} · {pluralize(app.levels.length, "level")}
            </Text>
          </div>
        </Group>
        <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>
          Add a level
        </Button>
      </Group>

      {app.managerNote && (
        <Text size="sm" px="lg" pt="sm" c="var(--mantine-color-yellow-light-color)">
          <IconAlertTriangle size={14} style={{ verticalAlign: "-2px" }} /> Managers: {app.managerNote}
        </Text>
      )}

      {app.tables.length === 0 ? (
        <Text size="sm" c="dimmed" p="lg">
          No tables yet. Add tables to this app from Tables & columns.
        </Text>
      ) : (
        <>
          <Group gap={4} px="lg" pt="sm" wrap="wrap">
            <Text size="xs" c="dimmed">
              Each cell: what that level can do in that table.
            </Text>
            <IconUser size={13} style={{ opacity: 0.7 }} aria-hidden />
            <Text size="xs" c="dimmed">
              = only their own records
            </Text>
            <HelpTip topic="ownOnly" size={13} />
          </Group>
          <Box className={classes.gridScroll}>
            <Table className={classes.levelGrid} verticalSpacing="xs" horizontalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th scope="col" className={classes.stickyCol}>
                    Table
                  </Table.Th>
                  {app.levels.map((l) => (
                    <Table.Th key={l.level} scope="col">
                      <Group gap={2} wrap="nowrap" justify="space-between">
                        <div style={{ minWidth: 0 }}>
                          <Text size="sm" fw={600} truncate maw={150}>
                            {l.name}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {pluralize(l.people, "person", "people")}
                          </Text>
                        </div>
                        {((app.resettable && !l.custom) || l.custom) && (
                          <Menu position="bottom-end" withinPortal>
                            <Menu.Target>
                              <ActionIcon variant="subtle" color="gray" size="sm" aria-label={`More for ${l.name}`}>
                                <IconDots size={15} />
                              </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                              {app.resettable && !l.custom && (
                                <Menu.Item
                                  leftSection={<IconRestore size={15} />}
                                  onClick={() =>
                                    confirmDanger({
                                      title: `Reset ${l.name}`,
                                      message: `${app.name} ${l.name} goes back to what the app came with. Tables you added to the app keep their rights.`,
                                      confirmLabel: "Reset",
                                      onConfirm: async () => {
                                        await reset.mutateAsync({ app: app.key, level: l.level });
                                        setDrafts(Object.fromEntries(Object.entries(drafts).filter(([k]) => k !== l.level)));
                                      },
                                    })
                                  }
                                >
                                  Reset to the app's defaults
                                </Menu.Item>
                              )}
                              {l.custom && (
                                <Menu.Item
                                  color="red"
                                  leftSection={<IconTrash size={15} />}
                                  onClick={() =>
                                    confirmDanger({
                                      title: `Remove ${l.name}`,
                                      message:
                                        l.people > 0
                                          ? `${pluralize(l.people, "person", "people")} will lose this level and what it gives them in ${app.name}.`
                                          : "Nobody has this level.",
                                      confirmLabel: "Remove level",
                                      onConfirm: async () => {
                                        await remove.mutateAsync({ app: app.key, level: l.level });
                                        setDrafts(Object.fromEntries(Object.entries(drafts).filter(([k]) => k !== l.level)));
                                      },
                                    })
                                  }
                                >
                                  Remove level
                                </Menu.Item>
                              )}
                            </Menu.Dropdown>
                          </Menu>
                        )}
                      </Group>
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {app.tables.map((t) => (
                  <Table.Tr key={t}>
                    <Table.Th scope="row" className={classes.stickyCol}>
                      <Text size="sm" fw={500}>
                        {tableTitle(t)}
                      </Text>
                    </Table.Th>
                    {app.levels.map((l) => {
                      const key = `${l.level}:${t}`;
                      return (
                        <Table.Td key={l.level}>
                          <Cell
                            label={`${tableTitle(t)} for ${l.name}`}
                            value={current(l.level)[t]}
                            changed={changed.has(key)}
                            onChange={(p) => setCell(l.level, t, p)}
                            custom={custom.has(key)}
                            onCustom={(on) => {
                              const next = new Set(custom);
                              if (on) next.add(key);
                              else next.delete(key);
                              setCustom(next);
                            }}
                          />
                        </Table.Td>
                      );
                    })}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        </>
      )}

      <Group justify="space-between" px="lg" py="sm" gap="xs" wrap="wrap" className={classes.saveBar}>
        <Text size="sm" c={changedCells.length ? undefined : "dimmed"}>
          {changedCells.length ? `${pluralize(changedCells.length, "change")} not saved yet` : "No changes"}
        </Text>
        <Group gap="xs">
          {changedCells.length > 0 && (
            <Button size="xs" variant="default" onClick={() => setDrafts({})}>
              Undo changes
            </Button>
          )}
          <Button size="xs" disabled={!changedCells.length} loading={save.isPending} onClick={saveAll}>
            Save changes
          </Button>
        </Group>
      </Group>
      <AddLevelModal app={app} opened={adding} onClose={() => setAdding(false)} />
    </Paper>
  );
}

/* ---------------- older roles: preview, then move ---------------- */

function MoveModal({
  opened,
  onClose,
  preview,
  error,
  onMove,
  moving,
}: {
  opened: boolean;
  onClose: () => void;
  preview: MovePreview | null;
  error: string | null;
  onMove: () => void;
  moving: boolean;
}) {
  return (
    <Modal opened={opened} onClose={onClose} title="Move older roles to levels" size="lg">
      <Stack>
        {error ? (
          <Alert color="red" title="Can't move them yet">
            {error}
          </Alert>
        ) : !preview ? (
          <Stack gap="xs">
            <Text size="sm" c="dimmed">
              Working out the move and checking every person…
            </Text>
            <Skeleton h={80} />
          </Stack>
        ) : (
          <>
            <Text size="sm">
              Each older role becomes a level in the apps it covers. <b>Everyone keeps exactly what they can do:</b> this was checked
              for every person and every table. Nothing changes until you press Move.
            </Text>
            <Stack gap={6}>
              {preview.roles.map((r) => (
                <Group key={r.name} gap="xs" wrap="wrap">
                  <Text size="sm" fw={600}>
                    {r.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    ({pluralize(r.people, "person", "people")})
                  </Text>
                  <IconArrowRight size={14} />
                  <Text size="sm">{r.becomes.length ? r.becomes.join(", ") : "nothing: it gave no access"}</Text>
                </Group>
              ))}
            </Stack>
            {preview.levels.length > 0 && (
              <Text size="sm" c="dimmed">
                New levels: {preview.levels.map((l) => `${l.app} · ${l.name}`).join(", ")}.
              </Text>
            )}
          </>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!preview || Boolean(error)} loading={moving} onClick={onMove}>
            Move older roles
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/* ---------------- page ---------------- */

export default function AccessLevelsPage() {
  const { data, isLoading, error } = useAccessLevels();
  const apps = useMemo(() => data?.apps ?? [], [data]);
  const narrow = useMediaQuery("(max-width: 62em)");
  // the app shown: ?app=… (links from a table's Access card), else the first
  const [params, setParams] = useSearchParams();
  const selected = apps.find((a) => a.key === params.get("app")) ?? apps[0];
  const choose = (key: string) => setParams({ app: key }, { replace: true });
  const [search, setSearch] = useState("");
  // changes not saved yet, per app (kept when switching apps)
  const [drafts, setDrafts] = useState<Record<string, Drafts>>({});
  const unsaved = (key: string) => Object.keys(drafts[key] ?? {}).length > 0;

  // older roles: a preview first (nothing changes), then the move
  const move = useMoveOlderRoles();
  const [moving, setMoving] = useState(false);
  const [preview, setPreview] = useState<MovePreview | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const openMove = () => {
    setMoving(true);
    setPreview(null);
    setMoveError(null);
    move.mutateAsync(false).then(setPreview, (err) => setMoveError(errorMessage(err)));
  };
  const doMove = () =>
    move.mutateAsync(true).then(
      () => setMoving(false),
      (err) => setMoveError(errorMessage(err))
    );

  const shown = apps.filter((a) => a.name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <Page title="Access levels" breadcrumbs={[{ label: "Settings", to: "/settings" }, { label: "Access levels" }]} width="full">
      <PageHeader
        title="Access levels"
        help="levels"
        description="What Staff, Managers and any levels you add can do in each app. Give people a level with App access on the Users page."
      />
      {isLoading ? (
        <Skeleton h={320} radius="lg" />
      ) : error ? (
        <Alert color="red">{errorMessage(error)}</Alert>
      ) : data ? (
        <Stack gap="lg">
          {data.olderRoles.length > 0 && (
            <Alert color="yellow" icon={<IconAlertTriangle size={16} />} title="Older roles to move">
              <Stack gap="xs">
                <Text size="sm">
                  These roles are from before access levels:{" "}
                  {data.olderRoles.map((r, i) => (
                    <span key={r._id}>
                      {i > 0 && ", "}
                      <b>{r.name}</b> ({pluralize(r.people, "person", "people")})
                    </span>
                  ))}
                  . Moving makes each one a level in the apps it covers. Everyone keeps exactly what they can do.
                </Text>
                <Group>
                  <Button size="xs" color="yellow" onClick={openMove}>
                    Preview the move
                  </Button>
                </Group>
              </Stack>
            </Alert>
          )}
          <Group gap={6}>
            <Badge color="red" variant="light">
              Administrators
            </Badge>
            <Text size="sm" c="dimmed">
              {pluralize(data.admins, "person", "people")} can always do everything. Choose who on the Users page.
            </Text>
            <HelpTip topic="administrator" size={14} />
          </Group>

          {selected && (
            <Grid gutter="lg">
              <Grid.Col span={{ base: 12, md: 3 }}>
                {narrow ? (
                  <Select
                    label="App"
                    data={apps.map((a) => ({ value: a.key, label: `${a.name}${unsaved(a.key) ? " •" : ""}` }))}
                    value={selected.key}
                    onChange={(v) => v && choose(v)}
                    allowDeselect={false}
                    searchable
                    leftSection={<AppIcon name={selected.icon} size={22} />}
                  />
                ) : (
                  <Paper withBorder radius="lg" p="xs">
                    {apps.length > 8 && (
                      <TextInput
                        size="xs"
                        mb="xs"
                        placeholder="Find an app"
                        aria-label="Find an app"
                        leftSection={<IconSearch size={14} />}
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                      />
                    )}
                    <nav aria-label="Apps">
                      {shown.map((a) => (
                        <NavLink
                          key={a.key}
                          active={a.key === selected.key}
                          onClick={() => choose(a.key)}
                          leftSection={<AppIcon name={a.icon} size={26} />}
                          label={a.name}
                          description={pluralize(a.tables.length, "table")}
                          rightSection={
                            unsaved(a.key) ? (
                              <Tooltip label="Changes not saved yet">
                                <Badge size="xs" color="yellow" variant="filled" circle aria-label="Changes not saved yet">
                                  •
                                </Badge>
                              </Tooltip>
                            ) : null
                          }
                          style={{ borderRadius: "var(--mantine-radius-md)" }}
                        />
                      ))}
                      {!shown.length && (
                        <Text size="sm" c="dimmed" p="xs">
                          No app matches.
                        </Text>
                      )}
                    </nav>
                  </Paper>
                )}
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 9 }}>
                <AppGrid
                  key={selected.key}
                  app={selected}
                  drafts={drafts[selected.key] ?? {}}
                  setDrafts={(d) => setDrafts((all) => ({ ...all, [selected.key]: d }))}
                />
              </Grid.Col>
            </Grid>
          )}
        </Stack>
      ) : null}
      <MoveModal opened={moving} onClose={() => setMoving(false)} preview={preview} error={moveError} onMove={doMove} moving={move.isPending && Boolean(preview)} />
    </Page>
  );
}

import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Skeleton,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconAlertTriangle, IconArrowRight, IconPlus } from "@tabler/icons-react";

import { errorMessage } from "../../api/api";
import {
  useAccessLevels,
  useAddLevel,
  useDeleteLevel,
  useMoveOlderRoles,
  useResetLevel,
  useSaveLevel,
  type AppLevels,
  type MovePreview,
  type PermissionMap,
  type TablePermission,
} from "../../api/reactQueryHooks/useAdmin";
import { confirmDanger } from "../../components/ui/confirm";
import { HelpTip } from "../../components/ui/HelpTip";
import { Page, PageHeader, Section } from "../../components/ui/Page";
import { AppIcon } from "../../features/apps/AppIcon";
import { tableTitle } from "../../layout/nav";
import { pluralize } from "../../lib/format";

/* ---------------- one simple choice per table ---------------- */

const NONE: TablePermission = { view: false, create: false, edit: false, delete: false };
const PRESETS = {
  none: { label: "No access", perm: NONE },
  view: { label: "View", perm: { view: true, create: false, edit: false, delete: false } },
  add: { label: "View and add", perm: { view: true, create: true, edit: false, delete: false } },
  work: { label: "View, add and edit", perm: { view: true, create: true, edit: true, delete: false } },
  all: { label: "Everything", perm: { view: true, create: true, edit: true, delete: true } },
} as const;
type Preset = keyof typeof PRESETS | "custom";
const PRESET_DATA = [
  ...Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })),
  { value: "custom", label: "Custom…" },
];

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

function TableRight({
  table,
  value,
  onChange,
  forceCustom,
  onCustom,
}: {
  table: string;
  value: TablePermission | undefined;
  onChange: (next: TablePermission | undefined) => void;
  // "Custom…" was picked: show the ticks even when they match a choice
  forceCustom: boolean;
  onCustom: (on: boolean) => void;
}) {
  const phone = useMediaQuery("(max-width: 36em)");
  const preset = forceCustom ? "custom" : presetOf(value);
  const set = (p: TablePermission) => onChange(p.view ? { ...p, ...(value?.own && p.view ? { own: true } : {}) } : undefined);
  return (
    <Stack gap={6} py={6} style={{ borderBottom: "1px solid var(--app-border)" }}>
      <Group justify="space-between" wrap={phone ? "wrap" : "nowrap"} gap="sm">
        <Text size="sm" fw={500} style={{ flex: 1, minWidth: 140 }}>
          {tableTitle(table)}
        </Text>
        <Group gap="sm" wrap="nowrap" style={phone ? { width: "100%" } : undefined}>
          <Select
            aria-label={`What this level can do in ${tableTitle(table)}`}
            data={PRESET_DATA}
            value={preset}
            allowDeselect={false}
            w={phone ? undefined : 200}
            style={phone ? { flex: 1 } : undefined}
            onChange={(v) => {
              if (v === "custom") return onCustom(true);
              onCustom(false);
              set(PRESETS[v as keyof typeof PRESETS].perm);
            }}
          />
          <Switch
            size="sm"
            label="Only their own"
            aria-label={`Only their own records in ${tableTitle(table)}`}
            disabled={!value?.view}
            checked={Boolean(value?.own)}
            onChange={(e) => value && onChange({ ...value, own: e.currentTarget.checked || undefined })}
          />
        </Group>
      </Group>
      {preset === "custom" && (
        <Group gap="md" pl={phone ? 0 : "md"}>
          {ACTIONS.map(([action, label]) => (
            <Checkbox
              key={action}
              size="sm"
              label={label}
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

/* ---------------- one app ---------------- */

function AddLevelModal({ app, opened, onClose, onAdded }: { app: AppLevels; opened: boolean; onClose: () => void; onAdded: (level: string) => void }) {
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
          add.mutateAsync({ app: app.key, name: name.trim() }).then(
            (l) => {
              onAdded(l.level);
              close();
            },
            (err) => setError(errorMessage(err))
          );
        }}
      >
        <Stack>
          <Text size="sm" c="dimmed">
            For a job between Staff and Manager. It starts with no access; choose what it can do in each table next.
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

function AppCard({ app }: { app: AppLevels }) {
  const [current, setCurrent] = useState(app.levels[0]?.level ?? "staff");
  const level = app.levels.find((l) => l.level === current) ?? app.levels[0];
  // edits not saved yet, per level
  const [drafts, setDrafts] = useState<Record<string, PermissionMap>>({});
  const [customRows, setCustomRows] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const save = useSaveLevel();
  const reset = useResetLevel();
  const remove = useDeleteLevel();
  if (!level) return null;
  const draft = drafts[level.level] ?? level.permissions;
  const dirty = Boolean(drafts[level.level]) && JSON.stringify(sorted(drafts[level.level])) !== JSON.stringify(sorted(level.permissions));
  const setTable = (table: string, p: TablePermission | undefined) => {
    const next = { ...draft };
    if (p?.view) next[table] = p;
    else delete next[table];
    setDrafts({ ...drafts, [level.level]: next });
  };

  return (
    <Section
      title={
        <Group gap="sm" wrap="nowrap">
          <AppIcon name={app.icon} size={28} />
          {app.name}
        </Group>
      }
      description={pluralize(app.tables.length, "table")}
      actions={
        <Button size="xs" variant="subtle" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>
          Add a level
        </Button>
      }
    >
      <Stack gap="sm">
        {app.levels.length <= 4 ? (
          <Box style={{ overflowX: "auto" }}>
            <SegmentedControl
              value={level.level}
              onChange={setCurrent}
              aria-label={`Level in ${app.name}`}
              data={app.levels.map((l) => ({
                value: l.level,
                label: `${l.name}${drafts[l.level] ? " •" : ""}`,
              }))}
            />
          </Box>
        ) : (
          // many levels: a list, with how many people have each
          <Select
            label="Level"
            aria-label={`Level in ${app.name}`}
            value={level.level}
            onChange={(v) => v && setCurrent(v)}
            allowDeselect={false}
            maw={360}
            data={app.levels.map((l) => ({
              value: l.level,
              label: `${l.name} (${pluralize(l.people, "person", "people")})${drafts[l.level] ? " •" : ""}`,
            }))}
          />
        )}
        <Text size="sm" c="dimmed">
          {pluralize(level.people, "person", "people")} {level.people === 1 ? "has" : "have"} this level.{" "}
          {level.level === "manager" && "Managers approve requests in this app."}
        </Text>
        {level.level === "manager" && app.managerNote && (
          <Text size="sm" c="var(--mantine-color-yellow-light-color)">
            <IconAlertTriangle size={14} style={{ verticalAlign: "-2px" }} /> {app.managerNote}
          </Text>
        )}

        {app.tables.length === 0 ? (
          <Text size="sm" c="dimmed">
            No tables yet. Add tables to this app from Tables & columns.
          </Text>
        ) : (
          <div>
            <Group gap={2} wrap="nowrap">
              <Text size="xs" c="dimmed">
                For each table: what this level can do, and whether only in their own records
              </Text>
              <HelpTip topic="ownOnly" size={13} />
            </Group>
            {app.tables.map((t) => (
              <TableRight
                key={t}
                table={t}
                value={draft[t]}
                onChange={(p) => setTable(t, p)}
                forceCustom={customRows.has(`${level.level}:${t}`)}
                onCustom={(on) => {
                  const next = new Set(customRows);
                  if (on) next.add(`${level.level}:${t}`);
                  else next.delete(`${level.level}:${t}`);
                  setCustomRows(next);
                }}
              />
            ))}
          </div>
        )}

        <Group justify="space-between" gap="xs" wrap="wrap">
          <Group gap="xs">
            {app.resettable && !level.custom && (
              <Button
                size="xs"
                variant="subtle"
                loading={reset.isPending}
                onClick={() =>
                  confirmDanger({
                    title: `Reset ${level.name}`,
                    message: `${app.name} ${level.name} goes back to what the app came with. Tables you added to the app keep their rights.`,
                    confirmLabel: "Reset",
                    onConfirm: async () => {
                      await reset.mutateAsync({ app: app.key, level: level.level });
                      setDrafts((d) => without(d, level.level));
                    },
                  })
                }
              >
                Reset to the app's defaults
              </Button>
            )}
            {level.custom && (
              <Button
                size="xs"
                variant="subtle"
                color="red"
                onClick={() =>
                  confirmDanger({
                    title: `Remove ${level.name}`,
                    message:
                      level.people > 0
                        ? `${pluralize(level.people, "person", "people")} will lose this level and what it gives them in ${app.name}.`
                        : "Nobody has this level.",
                    confirmLabel: "Remove level",
                    onConfirm: async () => {
                      await remove.mutateAsync({ app: app.key, level: level.level });
                      setCurrent(app.levels[0].level);
                    },
                  })
                }
              >
                Remove level
              </Button>
            )}
          </Group>
          <Group gap="xs">
            {dirty && (
              <Button size="xs" variant="default" onClick={() => setDrafts((d) => without(d, level.level))}>
                Undo changes
              </Button>
            )}
            <Button
              size="xs"
              disabled={!dirty}
              loading={save.isPending}
              onClick={() =>
                save.mutateAsync({ app: app.key, level: level.level, permissions: draft }).then(
                  () => setDrafts((d) => without(d, level.level)),
                  () => {}
                )
              }
            >
              Save {level.name}
            </Button>
          </Group>
        </Group>
      </Stack>
      <AddLevelModal app={app} opened={adding} onClose={() => setAdding(false)} onAdded={setCurrent} />
    </Section>
  );
}

// the drafts without this level's (saved, reset or undone)
const without = (drafts: Record<string, PermissionMap>, level: string) => Object.fromEntries(Object.entries(drafts).filter(([k]) => k !== level));

function sorted(map: PermissionMap) {
  return Object.keys(map)
    .sort()
    .map((k) => [k, Boolean(map[k].view), Boolean(map[k].create), Boolean(map[k].edit), Boolean(map[k].delete), Boolean(map[k].own)]);
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

// Administration → Access levels
export default function AccessLevelsPage() {
  const { data, isLoading, error } = useAccessLevels();
  const apps = useMemo(() => data?.apps ?? [], [data]);
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

  return (
    <Page title="Access levels" breadcrumbs={[{ label: "Administration" }, { label: "Access levels" }]} width="wide">
      <PageHeader
        title="Access levels"
        help="levels"
        description="What Staff, Managers and any levels you add can do in each app. Give people a level with App access on the Users page."
      />
      {isLoading ? (
        <Stack>
          <Skeleton h={160} radius="lg" />
          <Skeleton h={160} radius="lg" />
        </Stack>
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
          {apps.map((app) => (
            <AppCard key={app.key} app={app} />
          ))}
        </Stack>
      ) : null}
      <MoveModal opened={moving} onClose={() => setMoving(false)} preview={preview} error={moveError} onMove={doMove} moving={move.isPending && Boolean(preview)} />
    </Page>
  );
}

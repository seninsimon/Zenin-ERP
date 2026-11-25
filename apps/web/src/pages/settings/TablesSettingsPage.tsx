import { useMemo, useState } from "react";
import { Badge, Button, Group, Input, Menu, Modal, SegmentedControl, Select, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import { useForm } from "@mantine/form";
import { useMediaQuery } from "@mantine/hooks";
import { IconAlertTriangle, IconDatabaseCog, IconEyeOff, IconPlus, IconSettings, IconTable } from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";

import { useCreateTable, useTables } from "../../api/reactQueryHooks/useTables";
import { DataTable, type DataTableColumn } from "../../components/data-table";
import { EmptyState } from "../../components/ui/EmptyState";
import { Page, PageHeader } from "../../components/ui/Page";
import { formatDate, pluralize } from "../../lib/format";
import { errorMessage } from "../../api/api";
import { tablePath, tableTitle } from "../../layout/nav";
import { useTableHomes } from "../../api/reactQueryHooks/useApps";
import { AppIcon } from "../../features/apps/AppIcon";
import { WithHelp } from "../../components/ui/HelpTip";

// what the app's Staff may do in a new table (its Managers can do everything)
const STAFF_CHOICES = [
  { value: "none", label: "No access" },
  { value: "view", label: "View" },
  { value: "work", label: "View, add and edit" },
];

type TableRow = {
  _id: string;
  tableName: string;
  columns: { name: string }[];
  departments: { _id: string; name: string }[];
  showInMenu: boolean;
  createdAt: string;
  app?: { key: string; name: string; icon: string } | null;
  // false: everyone with access sees every record (departments don't matter)
  byDepartment?: boolean;
};

export const settingsTablePath = (table: string) => `/settings/tables/${encodeURIComponent(table)}`;

// Table names become database identifiers: keep them simple.
const TABLE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,59}$/u;

function NewTableModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const fullScreen = useMediaQuery("(max-width: 36em)");
  const create = useCreateTable();
  const { data: homes = [] } = useTableHomes();
  const form = useForm({
    initialValues: { tableName: "", app: "my-tables", staff: "work" },
    validate: {
      tableName: (v) =>
        !v.trim()
          ? "Enter a table name"
          : !TABLE_NAME.test(v.trim())
            ? "Use letters, numbers, spaces, - or _ (max 60 characters)"
            : null,
    },
  });

  const appName = homes.find((h) => h.key === form.values.app)?.name ?? "the app";
  const submit = form.onSubmit(async ({ tableName, app, staff }) => {
    const name = tableName.trim();
    try {
      // records seen by everyone who can use it (changeable in its Access settings)
      await create.mutateAsync({ tableName: name, byDepartment: false, app, staff });
      form.reset();
      onClose();
      navigate(settingsTablePath(name));
    } catch (err) {
      form.setFieldError("tableName", errorMessage(err, "Couldn't create the table"));
    }
  });

  return (
    <Modal opened={opened} onClose={onClose} title="New table" fullScreen={fullScreen}>
      <form onSubmit={submit}>
        <Stack>
          <TextInput
            label="Table name"
            description="Shown in the sidebar. You can add columns on the next screen."
            placeholder="e.g. Purchase orders"
            data-autofocus
            withAsterisk
            {...form.getInputProps("tableName")}
          />
          <Select
            label={<WithHelp topic="tableApp">App</WithHelp>}
            description="Where it shows in the sidebar, and whose people can use it"
            data={homes.map((h) => ({ value: h.key, label: h.name }))}
            leftSection={<AppIcon name={homes.find((h) => h.key === form.values.app)?.icon ?? "IconTable"} size={22} />}
            allowDeselect={false}
            {...form.getInputProps("app")}
          />
          <Input.Wrapper label={`What ${appName} Staff can do`} description={`${appName} Managers can do everything. You can change both later on the Roles page.`}>
            <SegmentedControl mt={6} fullWidth data={STAFF_CHOICES} {...form.getInputProps("staff")} aria-label="What Staff can do" />
          </Input.Wrapper>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create table
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// Administration → Tables & columns
export default function TablesSettingsPage() {
  const navigate = useNavigate();
  const { data = [], isLoading, isFetching, error, refetch } = useTables();
  const [creating, setCreating] = useState(false);
  const tables = data as TableRow[];

  const columns = useMemo<DataTableColumn<TableRow>[]>(
    () => [
      {
        id: "tableName",
        header: "Table",
        sortable: true,
        hideable: false,
        mobile: "title",
        width: 220,
        accessor: (t) => tableTitle(t.tableName),
        cell: (t) => (
          <Group gap="xs" wrap="nowrap">
            <IconTable size={16} stroke={1.75} opacity={0.6} aria-hidden />
            <div style={{ minWidth: 0 }}>
              <Text size="sm" fw={500} truncate>
                {tableTitle(t.tableName)}
              </Text>
              {tableTitle(t.tableName) !== t.tableName && (
                <Text size="xs" c="dimmed" ff="monospace" truncate>
                  {t.tableName}
                </Text>
              )}
            </div>
          </Group>
        ),
      },
      {
        id: "app",
        header: "App",
        sortable: true,
        width: 170,
        mobile: "subtitle",
        accessor: (t) => t.app?.name ?? "My tables",
        cell: (t) => (
          <Group gap={6} wrap="nowrap">
            <AppIcon name={t.app?.icon ?? "IconTable"} size={20} />
            <Text size="sm" truncate>
              {t.app?.name ?? "My tables"}
            </Text>
          </Group>
        ),
      },
      {
        id: "columns",
        header: "Columns",
        sortable: true,
        align: "right",
        width: 90,
        accessor: (t) => t.columns?.length ?? 0,
        cell: (t) => <span className="tabular-nums">{t.columns?.length ?? 0}</span>,
      },
      {
        id: "departments",
        header: "Access",
        width: 260,
        mobile: "field",
        accessor: (t) => (t.byDepartment === false ? "Everyone with access" : t.departments.map((d) => d.name).join(", ")),
        cell: (t) =>
          t.byDepartment === false ? (
            <Text size="sm" c="dimmed">
              Everyone with access
            </Text>
          ) : t.departments.length ? (
            <Group gap={4} wrap="nowrap">
              {t.departments.slice(0, 3).map((d) => (
                <Badge key={d._id} variant="default">
                  {d.name}
                </Badge>
              ))}
              {t.departments.length > 3 && <Badge variant="default">+{t.departments.length - 3}</Badge>}
            </Group>
          ) : (
            <Tooltip label="Split by department, but with no department: only admins can use it">
              <Badge color="yellow" leftSection={<IconAlertTriangle size={12} />}>
                Admins only
              </Badge>
            </Tooltip>
          ),
      },
      {
        id: "showInMenu",
        header: "Menu",
        width: 140,
        accessor: (t) => (t.showInMenu === false ? "Hidden" : "Shown"),
        cell: (t) =>
          t.showInMenu === false ? (
            <Badge color="gray" leftSection={<IconEyeOff size={12} />}>
              Hidden from menu
            </Badge>
          ) : (
            <Text size="sm" c="dimmed">
              In sidebar
            </Text>
          ),
      },
      {
        id: "createdAt",
        header: "Created",
        sortable: true,
        width: 130,
        accessor: (t) => t.createdAt,
        cell: (t) => <span className="tabular-nums">{formatDate(t.createdAt)}</span>,
      },
    ],
    []
  );

  return (
    <Page title="Tables & columns" breadcrumbs={[{ label: "Administration" }, { label: "Tables & columns" }]} width="wide">
      <PageHeader
        title="Tables & columns"
        description="Create tables, put each in an app, and define their columns."
        meta={tables.length ? <Badge variant="default">{pluralize(tables.length, "table")}</Badge> : undefined}
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            New table
          </Button>
        }
      />

      <DataTable
        label="Tables"
        data={tables}
        columns={columns}
        getRowId={(t) => t.tableName}
        loading={isLoading}
        fetching={isFetching}
        error={error ? errorMessage(error) : null}
        onRetry={refetch}
        searchPlaceholder="Search tables…"
        storageKey="settings:tables"
        onRowClick={(t) => navigate(settingsTablePath(t.tableName))}
        rowActions={(t) => (
          <>
            <Menu.Item leftSection={<IconSettings size={16} />} onClick={() => navigate(settingsTablePath(t.tableName))}>
              Configure
            </Menu.Item>
            <Menu.Item leftSection={<IconTable size={16} />} onClick={() => navigate(tablePath(t.tableName))}>
              Open records
            </Menu.Item>
          </>
        )}
        emptyState={(filtered) =>
          filtered ? (
            <EmptyState title="No matching tables" description="Try a different search." />
          ) : (
            <EmptyState
              icon={<IconDatabaseCog size={26} stroke={1.5} />}
              title="Create your first table"
              description="Tables hold your records, for example customers, orders or projects. Add columns after creating it."
              action={
                <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
                  New table
                </Button>
              }
            />
          )
        }
      />

      <NewTableModal opened={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

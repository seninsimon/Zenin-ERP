import { useState } from "react";
import { ActionIcon, Alert, Button, Group, Modal, Select, Stack, Switch, Text, Textarea, TextInput, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconBolt, IconPencil, IconPlus, IconSparkles, IconTrash, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import api, { automationWithAi, errorMessage, getAiBuilders } from "../../api/api";
import { useTables } from "../../api/reactQueryHooks/useTables";
import { Section } from "../../components/ui/Page";
import { EmptyState } from "../../components/ui/EmptyState";
import { columnLabel, type RecordColumn } from "../../features/records/schema";

type Trigger = { when: "created" } | { when: "changed"; column: string; to?: string };
type Action = { do: "set"; column: string; value: unknown } | { do: "notify"; who: string; message?: string };
type Automation = { _id: string; name: string; trigger: Trigger; actions: Action[]; enabled: boolean };

const CREATOR = "$creator";
const MANAGERS = "$managers";

type WhoOption = { value: string; label: string };

// Who an automation can tell: the creator, the table's managers, a person
// field, or the person in a linked record ("the person in Employee").
function useWhoOptions(columns: RecordColumn[]): WhoOption[] {
  const { data: tables = [] } = useTables();
  const linked = columns
    .filter((c) => c.type === "relation" && c.ref)
    .flatMap((c) => {
      const target = (tables as { tableName: string; columns?: RecordColumn[] }[]).find((t) => t.tableName === c.ref);
      return (target?.columns ?? [])
        .filter((u) => u.type === "user")
        .map((u) => ({ value: `${c.name}.${u.name}`, label: `The person in ${columnLabel(c)} (${columnLabel(u)})` }));
    });
  return [
    { value: CREATOR, label: "The person who created it" },
    { value: MANAGERS, label: "Its managers (people who can change every record)" },
    ...columns.filter((c) => c.type === "user").map((c) => ({ value: c.name, label: `The person in ${columnLabel(c)}` })),
    ...linked,
  ];
}
const SETTABLE = ["text", "textarea", "number", "date", "boolean", "choice", "user"];
// what "set" can put into a field of each type, besides a typed value
const SPECIAL: Record<string, { value: string; label: string }> = {
  date: { value: "today", label: "Today" },
  user: { value: "$me", label: "The person who made the change" },
};

// One automation as a sentence: "When Status becomes Approved → set Approved on to today, tell the person who created it"
function sentence(a: Pick<Automation, "trigger" | "actions">, columns: RecordColumn[], who: WhoOption[]) {
  const name = (n: string) => {
    const c = columns.find((x) => x.name === n);
    return c ? columnLabel(c) : n;
  };
  const when =
    a.trigger.when === "created"
      ? "When a record is added"
      : `When ${name(a.trigger.column)} ${a.trigger.to ? `becomes ${a.trigger.to}` : "changes"}`;
  const then = a.actions.map((x) =>
    x.do === "notify"
      ? `tell ${(who.find((w) => w.value === x.who)?.label ?? `the person in ${name(x.who)}`).replace(/^The /, "the ").replace(/^Its /, "its ").replace(/ \(people who can change every record\)$/, "")}${x.message ? ` “${x.message}”` : ""}`
      : `set ${name(x.column)} to ${x.value === "today" ? "today" : x.value === "$me" ? "the person who made the change" : String(x.value)}`
  );
  return `${when} → ${then.join(", ")}`;
}

function ActionRow({
  action,
  columns,
  onChange,
  onRemove,
  who,
}: {
  action: Action;
  columns: RecordColumn[];
  who: WhoOption[];
  onChange: (a: Action) => void;
  onRemove?: () => void;
}) {
  const settable = columns.filter((c) => SETTABLE.includes(c.type));
  const target = action.do === "set" ? columns.find((c) => c.name === action.column) : undefined;
  return (
    <Group gap="xs" align="flex-end" wrap="nowrap">
      <Select
        label="Then"
        data={[
          { value: "notify", label: "Tell someone" },
          { value: "set", label: "Set a field" },
        ]}
        value={action.do}
        onChange={(v) => onChange(v === "set" ? { do: "set", column: "", value: null } : { do: "notify", who: CREATOR })}
        allowDeselect={false}
        w={140}
      />
      {action.do === "notify" ? (
        <>
          <Select
            label="Who"
            data={who}
            value={action.who}
            onChange={(v) => onChange({ ...action, who: v ?? CREATOR })}
            allowDeselect={false}
            w={200}
          />
          <TextInput
            label="Message (optional)"
            placeholder="e.g. Your leave was approved"
            value={action.message ?? ""}
            onChange={(e) => onChange({ ...action, message: e.currentTarget.value })}
            style={{ flex: 1 }}
          />
        </>
      ) : (
        <>
          <Select
            label="Field"
            placeholder="Choose"
            data={settable.map((c) => ({ value: c.name, label: columnLabel(c) }))}
            value={action.column || null}
            onChange={(v) => {
              const col = columns.find((c) => c.name === v);
              onChange({ do: "set", column: v ?? "", value: col && SPECIAL[col.type] ? SPECIAL[col.type].value : null });
            }}
            w={170}
          />
          {target && SPECIAL[target.type] ? (
            <TextInput label="To" value={SPECIAL[target.type].label} readOnly variant="filled" style={{ flex: 1 }} />
          ) : target?.type === "choice" ? (
            <Select
              label="To"
              data={(target.options ?? []).map((o) => o.label)}
              value={typeof action.value === "string" ? action.value : null}
              onChange={(v) => onChange({ ...action, value: v })}
              style={{ flex: 1 }}
            />
          ) : target?.type === "boolean" ? (
            <Select
              label="To"
              data={[
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ]}
              value={action.value === true ? "true" : action.value === false ? "false" : null}
              onChange={(v) => onChange({ ...action, value: v === "true" })}
              style={{ flex: 1 }}
            />
          ) : (
            <TextInput
              label="To"
              value={action.value == null ? "" : String(action.value)}
              onChange={(e) =>
                onChange({ ...action, value: target?.type === "number" ? Number(e.currentTarget.value) : e.currentTarget.value })
              }
              disabled={!target}
              style={{ flex: 1 }}
            />
          )}
        </>
      )}
      {onRemove && (
        <ActionIcon variant="subtle" color="gray" mb={4} aria-label="Remove this step" onClick={onRemove}>
          <IconX size={16} />
        </ActionIcon>
      )}
    </Group>
  );
}

function AutomationModal({
  table,
  columns,
  editing,
  draft,
  opened,
  onClose,
}: {
  table: string;
  columns: RecordColumn[];
  editing: Automation | null;
  // drafted by the AI from a description: filled in, to check and save
  draft?: { trigger: Trigger; actions: Action[]; from: string };
  opened: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const who = useWhoOptions(columns);
  const [trigger, setTrigger] = useState<Trigger>(editing?.trigger ?? draft?.trigger ?? { when: "created" });
  const [actions, setActions] = useState<Action[]>(editing?.actions ?? draft?.actions ?? [{ do: "notify", who: CREATOR }]);
  const [error, setError] = useState<string | null>(null);
  const watched = columns.filter((c) => !["formula", "rollup", "autonumber", "richtext", "image", "images", "file", "files"].includes(c.type));
  const watchedColumn = trigger.when === "changed" ? columns.find((c) => c.name === trigger.column) : undefined;

  const save = useMutation({
    mutationFn: async () => {
      const body = { name: editing?.name ?? "", trigger, actions, enabled: editing?.enabled ?? true };
      return editing ? api.put(`/schema/${table}/automations/${editing._id}`, body) : api.post(`/schema/${table}/automations`, body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["automations", table] });
      notifications.show({ title: "Automation saved", message: sentence({ trigger, actions }, columns, who), color: "green" });
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  return (
    <Modal opened={opened} onClose={onClose} title={editing ? "Edit automation" : "New automation"} size="xl">
      <Stack>
        {draft && (
          <Alert variant="light" color="grape" icon={<IconSparkles size={18} />} title="Drafted by AI: check it, then save">
            From “{draft.from}”. It's below as you'd fill it in yourself, and in words at the bottom. Nothing runs until you save it.
          </Alert>
        )}
        <Group gap="xs" align="flex-end" wrap="wrap">
          <Select
            label="When"
            data={[
              { value: "created", label: "A record is added" },
              ...watched.map((c) => ({ value: c.name, label: `${columnLabel(c)} changes` })),
            ]}
            value={trigger.when === "created" ? "created" : trigger.column}
            onChange={(v) => setTrigger(!v || v === "created" ? { when: "created" } : { when: "changed", column: v })}
            allowDeselect={false}
            w={240}
          />
          {watchedColumn?.type === "choice" && trigger.when === "changed" && (
            <Select
              label="To"
              data={[{ value: "", label: "Any value" }, ...(watchedColumn.options ?? []).map((o) => ({ value: o.label, label: o.label }))]}
              value={trigger.to ?? ""}
              onChange={(v) => setTrigger({ ...trigger, to: v || undefined })}
              allowDeselect={false}
              w={180}
            />
          )}
        </Group>
        {actions.map((a, i) => (
          <ActionRow
            key={i}
            action={a}
            columns={columns}
            who={who}
            onChange={(next) => setActions((prev) => prev.map((x, j) => (j === i ? next : x)))}
            onRemove={actions.length > 1 ? () => setActions((prev) => prev.filter((_, j) => j !== i)) : undefined}
          />
        ))}
        <Button
          variant="default"
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={() => setActions((prev) => [...prev, { do: "notify", who: CREATOR }])}
          style={{ alignSelf: "flex-start" }}
          disabled={actions.length >= 10}
        >
          Also do
        </Button>
        <Text size="sm" c="dimmed">
          {sentence({ trigger, actions }, columns, who)}
        </Text>
        {error && (
          <Text size="sm" c="var(--mantine-color-error)">
            {error}
          </Text>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save automation
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// Table settings: things that happen by themselves when records change.
export function AutomationsSection({ table, columns }: { table: string; columns: RecordColumn[] }) {
  const qc = useQueryClient();
  const who = useWhoOptions(columns);
  const { data: automations = [] } = useQuery({
    queryKey: ["automations", table],
    queryFn: async () => (await api.get<Automation[]>(`/schema/${table}/automations`)).data,
  });
  const [modal, setModal] = useState<{ editing: Automation | null; draft?: { trigger: Trigger; actions: Action[]; from: string } } | null>(null);
  const [describing, setDescribing] = useState(false);
  const aiOn = Boolean(useQuery({ queryKey: ["aiBuilders"], queryFn: async () => (await getAiBuilders()).data, staleTime: 60_000 }).data?.automation);
  const toggle = useMutation({
    mutationFn: async (a: Automation) => api.put(`/schema/${table}/automations/${a._id}`, { ...a, enabled: !a.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automations", table] }),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/schema/${table}/automations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["automations", table] }),
  });

  return (
    <Section
      title="Automations"
      help="automations"
      description="Things that happen by themselves when records change, like telling someone their leave was approved."
      actions={
        <Group gap="xs">
          {aiOn && (
            <Button variant="light" leftSection={<IconSparkles size={16} />} onClick={() => setDescribing(true)}>
              Describe it with AI
            </Button>
          )}
          <Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => setModal({ editing: null })}>
            Add automation
          </Button>
        </Group>
      }
      padding="md"
    >
      {automations.length ? (
        <Stack gap="xs">
          {automations.map((a) => (
            <Group key={a._id} justify="space-between" wrap="nowrap" gap="sm">
              <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                <IconBolt size={16} color="var(--mantine-color-yellow-6)" style={{ flexShrink: 0 }} />
                <Text size="sm" c={a.enabled ? undefined : "dimmed"} td={a.enabled ? undefined : "line-through"}>
                  {sentence(a, columns, who)}
                </Text>
              </Group>
              <Group gap={4} wrap="nowrap">
                <Tooltip label={a.enabled ? "On" : "Off"}>
                  <Switch checked={a.enabled} onChange={() => toggle.mutate(a)} aria-label="On" size="sm" />
                </Tooltip>
                <ActionIcon variant="subtle" color="gray" aria-label="Edit" onClick={() => setModal({ editing: a })}>
                  <IconPencil size={16} />
                </ActionIcon>
                <ActionIcon variant="subtle" color="red" aria-label="Delete" onClick={() => remove.mutate(a._id)}>
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            </Group>
          ))}
        </Stack>
      ) : (
        <EmptyState compact title="No automations yet" description="For example: when Status becomes Approved, tell the person who asked." />
      )}
      {modal && (
        <AutomationModal
          key={modal.editing?._id ?? "new"}
          table={table}
          columns={columns}
          editing={modal.editing}
          draft={modal.draft}
          opened
          onClose={() => setModal(null)}
        />
      )}
      {describing && (
        <DescribeAutomation
          table={table}
          onClose={() => setDescribing(false)}
          onDraft={(draft) => {
            setDescribing(false);
            setModal({ editing: null, draft });
          }}
        />
      )}
    </Section>
  );
}

// "Describe it with AI": the AI drafts an automation from plain words; it
// opens in the normal window to check and save (nothing runs before that)
function DescribeAutomation({
  table,
  onClose,
  onDraft,
}: {
  table: string;
  onClose: () => void;
  onDraft: (draft: { trigger: Trigger; actions: Action[]; from: string }) => void;
}) {
  const phone = useMediaQuery("(max-width: 36em)");
  const [wish, setWish] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await automationWithAi(table, wish);
      onDraft({ trigger: data.trigger as Trigger, actions: data.actions as Action[], from: wish.trim() });
    } catch (err) {
      setError(errorMessage(err, "The AI couldn't draft it"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title="Describe the automation" size="lg" fullScreen={phone}>
      <Stack gap="sm">
        <Textarea
          label="What should happen?"
          description="Say it in your own words, in English or Malayalam. The AI gets only this and the field names, never records."
          placeholder="e.g. When a leave request is approved, tell the employee and set Approved on to today"
          autosize
          minRows={3}
          maxRows={6}
          maxLength={500}
          value={wish}
          autoFocus
          onChange={(e) => setWish(e.currentTarget.value)}
        />
        {error && (
          <Text size="sm" c="var(--mantine-color-error)">
            {error}
          </Text>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button leftSection={<IconSparkles size={16} />} loading={busy} disabled={wish.trim().length < 3} onClick={draft}>
            Draft it
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// Cliente mínimo da API v2 do ClickUp usando fetch nativo.
// Docs: https://developer.clickup.com/reference

const BASE_URL = "https://api.clickup.com/api/v2";

export interface ClickUpTask {
  id: string;
  name: string;
  url: string;
  status: { status: string; type: string };
  priority: { id: string; priority: string } | null;
  due_date: string | null; // epoch ms em string
  start_date: string | null;
  date_done: string | null;
  date_closed: string | null;
  date_created: string;
  time_estimate: number | null; // ms
  list: { id: string; name: string };
  tags: { name: string }[];
  parent: string | null;
}

export interface ClickUpSpace {
  id: string;
  name: string;
}

export interface ClickUpList {
  id: string;
  name: string;
}

export class ClickUpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ClickUpError";
  }
}

export function getClickUpToken(): string {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) throw new Error("CLICKUP_API_TOKEN is not set");
  return token;
}

async function request<T>(
  token: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    // Nunca inclui o token na mensagem de erro — só status e corpo da resposta.
    const text = await res.text().catch(() => "");
    throw new ClickUpError(
      `ClickUp ${method} ${path.split("?")[0]} falhou (${res.status}): ${text.slice(0, 500)}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

// ─── Workspace / Space / List / Tag ───────────────────────────────

export async function getWorkspaces(token: string) {
  const data = await request<{ teams: { id: string; name: string }[] }>(token, "GET", "/team");
  return data.teams;
}

export async function getSpaces(token: string, teamId: string) {
  const data = await request<{ spaces: ClickUpSpace[] }>(
    token,
    "GET",
    `/team/${teamId}/space?archived=false`,
  );
  return data.spaces;
}

export async function createSpace(token: string, teamId: string, name: string) {
  return request<ClickUpSpace>(token, "POST", `/team/${teamId}/space`, {
    name,
    multiple_assignees: false,
    features: {
      due_dates: { enabled: true, start_date: true, remap_due_dates: true, remap_closed_due_date: false },
      time_estimates: { enabled: true },
      tags: { enabled: true },
      priorities: { enabled: true },
      checklists: { enabled: true },
    },
  });
}

export async function getFolderlessLists(token: string, spaceId: string) {
  const data = await request<{ lists: ClickUpList[] }>(
    token,
    "GET",
    `/space/${spaceId}/list?archived=false`,
  );
  return data.lists;
}

export async function createFolderlessList(token: string, spaceId: string, name: string, content?: string) {
  return request<ClickUpList>(token, "POST", `/space/${spaceId}/list`, { name, content });
}

export async function getSpaceTags(token: string, spaceId: string) {
  const data = await request<{ tags: { name: string }[] }>(token, "GET", `/space/${spaceId}/tag`);
  return data.tags;
}

export async function createSpaceTag(token: string, spaceId: string, name: string, bg: string) {
  await request<unknown>(token, "POST", `/space/${spaceId}/tag`, {
    tag: { name, tag_fg: "#ffffff", tag_bg: bg },
  });
}

// ─── Tasks ────────────────────────────────────────────────────────

export interface TeamTaskFilter {
  spaceIds?: string[];
  listIds?: string[];
  includeClosed?: boolean;
  dateDoneGt?: number;
  dueDateLt?: number;
}

/** Busca todas as tarefas do workspace que batem com o filtro (pagina até acabar). */
export async function getTeamTasks(token: string, teamId: string, filter: TeamTaskFilter) {
  const all: ClickUpTask[] = [];
  const MAX_PAGES = 20; // trava de segurança: 2.000 tarefas

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("subtasks", "true");
    params.set("include_closed", String(filter.includeClosed ?? false));
    filter.spaceIds?.forEach((id) => params.append("space_ids[]", id));
    filter.listIds?.forEach((id) => params.append("list_ids[]", id));
    if (filter.dateDoneGt) params.set("date_done_gt", String(filter.dateDoneGt));
    if (filter.dueDateLt) params.set("due_date_lt", String(filter.dueDateLt));

    const data = await request<{ tasks: ClickUpTask[]; last_page?: boolean }>(
      token,
      "GET",
      `/team/${teamId}/task?${params.toString()}`,
    );
    all.push(...data.tasks);
    if (data.last_page !== false || data.tasks.length < 100) break;
  }
  return all;
}

export interface NewTask {
  name: string;
  markdown_content?: string;
  tags?: string[];
  priority?: 1 | 2 | 3 | 4 | null; // 1=Urgente 2=Alta 3=Normal 4=Baixa
  due_date?: number;
  due_date_time?: boolean;
  time_estimate?: number; // ms
}

export async function createTask(token: string, listId: string, task: NewTask) {
  return request<ClickUpTask>(token, "POST", `/list/${listId}/task`, task);
}

export async function updateTask(token: string, taskId: string, patch: Partial<NewTask>) {
  return request<ClickUpTask>(token, "PUT", `/task/${taskId}`, patch);
}
